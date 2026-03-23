export type MemoryRecallGuidanceVariant = 'generic' | 'voice';

export function buildMemoryRecallGuidanceBlockV1(variant: MemoryRecallGuidanceVariant): string {
  if (variant === 'voice') {
    return [
      'Memory recall:',
      '- If the user asks what you remember from earlier conversations or decisions, use memorySearch first instead of guessing from model memory.',
      '- If a hit needs verification before you answer, use memoryGetWindow to verify the exact details.',
      '- If memory search finds nothing, say that plainly instead of inventing an answer.',
    ].join('\n');
  }

  return [
    '# Memory recall',
    '',
    '- If the user asks you to remember or find something from past conversations, use `memory_search` first instead of guessing from model memory or searching provider-native memory files.',
    '- If you find a likely hit and need to verify details before answering, use `memory_get_window` on that hit.',
    '- If `memory_search` finds nothing, say that clearly instead of inventing an answer.',
  ].join('\n');
}
