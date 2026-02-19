export function isThinkingToolName(toolName: string): boolean {
  return toolName.trim().toLowerCase() === 'think';
}

export function extractThinkingTextFromThinkToolInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';

  const record = input as Record<string, unknown>;
  const direct = record.thinking ?? record.thought ?? record.text ?? record.content;
  return typeof direct === 'string' ? direct : '';
}

