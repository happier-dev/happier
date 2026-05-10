import {
  readRuntimeDescriptorV1FromMetadata,
  writeRuntimeDescriptorV1ToMetadata,
  type RuntimeDescriptorV1,
  type SessionMetadata,
} from '@happier-dev/protocol';

import type { SessionStateBinding, SessionStateStoredValue } from './_types.js';

export function readRuntimeDescriptorSessionState(
  metadata: SessionMetadata,
): SessionStateStoredValue<'identity.runtimeDescriptor'> {
  return {
    value: readRuntimeDescriptorV1FromMetadata(metadata),
    updatedAt: null,
  };
}

export function writeRuntimeDescriptorSessionState<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  descriptor: RuntimeDescriptorV1 | null,
): TMetadata {
  return writeRuntimeDescriptorV1ToMetadata(metadata, descriptor) as TMetadata;
}

export const runtimeDescriptorBinding: SessionStateBinding<'identity.runtimeDescriptor'> = {
  read: readRuntimeDescriptorSessionState,
  write: (metadata, update) => writeRuntimeDescriptorSessionState(
    metadata as SessionMetadata & Record<string, unknown>,
    update.value,
  ) as SessionMetadata,
};
