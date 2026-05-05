import type { SessionId } from '../idsV1.js';
import type { ExternalSessionTakeoverInputV1 } from './takeoverV1.js';

export type DirectSessionsTakeoverLegacyInputV1 = Readonly<{
  linkedSessionId: SessionId;
  forceStop?: boolean;
}>;

export function mapDirectSessionsTakeoverToExternalSessionTakeoverInputV1(
  legacy: DirectSessionsTakeoverLegacyInputV1,
): ExternalSessionTakeoverInputV1 {
  return {
    linkedSessionId: legacy.linkedSessionId,
    targetRuntimeMode: 'terminal',
    storageMode: 'external-linked',
    ...(legacy.forceStop === undefined ? {} : { forceStop: legacy.forceStop }),
  };
}

export function mapDirectSessionsTakeoverPersistToExternalSessionTakeoverInputV1(
  legacy: DirectSessionsTakeoverLegacyInputV1,
): ExternalSessionTakeoverInputV1 {
  return {
    linkedSessionId: legacy.linkedSessionId,
    targetRuntimeMode: 'terminal',
    storageMode: 'persisted',
    ...(legacy.forceStop === undefined ? {} : { forceStop: legacy.forceStop }),
  };
}
