import { fetch as expoFetch } from 'expo/fetch';

export const openAiProviderFetch: typeof globalThis.fetch = (input, init) => (
  expoFetch(input, init)
);
