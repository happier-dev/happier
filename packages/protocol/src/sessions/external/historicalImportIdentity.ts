import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export const EXTERNAL_SESSION_HISTORICAL_IMPORT_LOCAL_ID_PREFIX = 'direct-import:v1:';

export function makeExternalSessionHistoricalImportLocalId(params: Readonly<{
  agentId: string;
  remoteSessionId: string;
  directItemId: string;
}>): string {
  const digest = bytesToHex(sha256(utf8ToBytes(
    `${params.agentId}:${params.remoteSessionId}:${params.directItemId}`,
  ))).slice(0, 24);
  return `${EXTERNAL_SESSION_HISTORICAL_IMPORT_LOCAL_ID_PREFIX}${params.agentId}:${digest}`;
}
