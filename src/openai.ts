import OpenAI from "openai";



// const configuration = new Configuration({
//   apiKey: process.env.OPENAI_API_KEY,
// });

export const MAX_OPEN_AI_QUERY_LENGTH = 20000;
export const MODEL_NAME = "gpt-4o-mini";
export const TEMPERATURE = 0.5;
export const MAX_TOKENS = 512;

export const openai = new OpenAI();
