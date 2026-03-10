export function buildAppendSystemPromptV1(args: Readonly<{ blocks: ReadonlyArray<string | null | undefined> }>): string {
  const blocks = Array.isArray(args.blocks) ? args.blocks : [];
  const parts = blocks.map((b) => (typeof b === 'string' ? b.trim() : '')).filter((b) => b.length > 0);
  return parts.join('\n\n').trim();
}
