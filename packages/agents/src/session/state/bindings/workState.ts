import {
  readSessionWorkStateV1FromMetadata,
  writeSessionWorkStateV1ToMetadata,
  type SessionMetadata,
  type SessionWorkStateV1,
} from '@happier-dev/protocol';

import type { SessionStateBinding, SessionStateStoredValue } from '../_types.js';

export function readSessionWorkStateSessionState(
  metadata: SessionMetadata,
): SessionStateStoredValue<'runtime.workState'> {
  const value = readSessionWorkStateV1FromMetadata(metadata);
  return {
    value,
    updatedAt: value?.updatedAt ?? null,
  };
}

export function writeSessionWorkStateSessionState<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  workState: SessionWorkStateV1 | null,
): TMetadata {
  return writeSessionWorkStateV1ToMetadata(metadata, workState);
}

export const sessionWorkStateBinding: SessionStateBinding<'runtime.workState'> = {
  read: readSessionWorkStateSessionState,
  write: (metadata, update) => writeSessionWorkStateSessionState(
    metadata,
    update.value,
  ),
};
