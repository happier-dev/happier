export function isDefaultWriteLikeToolName(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  // Safety: when a provider reports an unknown tool name, treat it as write-like.
  if (lower === 'other' || lower === 'unknown tool' || lower === 'unknown') return true;

  const writeish = [
    'edit',
    'write',
    'patch',
    'delete',
    'remove',
    'create',
    'mkdir',
    'rename',
    'move',
    'copy',
    'exec',
    'bash',
    'shell',
    'run',
    'terminal',
  ];
  return writeish.some((k) => lower === k || lower.includes(k));
}

