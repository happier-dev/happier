import type { SessionId } from '../idsV1.js';
import type { ExternalSessionTakeoverInputV1 } from './takeoverV1.js';

export type ExternalSessionsTakeoverLegacyInputV1 = Readonly<{
  linkedSessionId: SessionId;
  forceStop?: boolean;
}>;

export function mapExternalSessionsTakeoverToExternalSessionTakeoverInputV1(
  legacy: ExternalSessionsTakeoverLegacyInputV1,
): ExternalSessionTakeoverInputV1 {
  return {
    linkedSessionId: legacy.linkedSessionId,
    targetRuntimeMode: 'terminal',
    storageMode: 'external-linked',
    ...(legacy.forceStop === undefined ? {} : { forceStop: legacy.forceStop }),
  };
}

export function mapExternalSessionsTakeoverPersistToExternalSessionTakeoverInputV1(
  legacy: ExternalSessionsTakeoverLegacyInputV1,
): ExternalSessionTakeoverInputV1 {
  return {
    linkedSessionId: legacy.linkedSessionId,
    targetRuntimeMode: 'terminal',
    storageMode: 'persisted',
    ...(legacy.forceStop === undefined ? {} : { forceStop: legacy.forceStop }),
  };
}
