import { readSessionStateFieldFromMetadata } from '@happier-dev/agents';
import type { SessionMetadata } from '@happier-dev/protocol';

/** Guard facts carry authored titles; localized untitled copy belongs to the presenter. */
export function readGuardSessionTitle(metadata: SessionMetadata | undefined): string | null {
  if (!metadata) return null;
  const title = readSessionStateFieldFromMetadata(metadata, 'display.title')?.trim();
  const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
  return title || name || null;
}
