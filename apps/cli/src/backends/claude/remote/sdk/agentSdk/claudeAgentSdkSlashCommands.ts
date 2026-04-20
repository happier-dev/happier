export function parseRewindCommand(message: string): { type: 'rewind'; checkpointId?: string; confirmed: boolean } | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/rewind')) return null;

  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts[0] !== '/rewind') return null;

  let checkpointId: string | undefined;
  let confirmed = false;

  for (const part of parts.slice(1)) {
    if (part === '--confirm' || part === '--yes' || part === '-y') {
      confirmed = true;
      continue;
    }

    if (part.startsWith('-')) continue;
    if (!checkpointId) checkpointId = part;
  }

  return { type: 'rewind', checkpointId, confirmed };
}

export function parseCheckpointsCommand(message: string): { type: 'checkpoints' } | null {
  const trimmed = message.trim();
  if (trimmed === '/checkpoints') return { type: 'checkpoints' };
  return null;
}
