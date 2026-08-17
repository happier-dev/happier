export const openAiProviderFetch: typeof globalThis.fetch = (input, init) => (
  globalThis.fetch(input, init)
);
