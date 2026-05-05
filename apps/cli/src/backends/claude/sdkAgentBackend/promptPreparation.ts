export function prepareClaudeSdkPrompt(prompt: string): string {
  return typeof prompt === 'string' ? prompt : '';
}
