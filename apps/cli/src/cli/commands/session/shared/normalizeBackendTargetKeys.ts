import {
  BackendTargetKeySchema,
  BackendTargetKeyV2Schema,
  buildBackendTargetKey,
  buildBackendTargetKeyV2,
  convertBackendTargetRefV2ToV1,
  parseBackendTargetKey,
  readBackendTargetRefV2,
  type BackendTargetRefV1,
} from '@happier-dev/protocol';
import { getAgentCatalogDefinition } from '@happier-dev/agents';

function normalizeBackendTargetKeyFromInput(entry: string): string | null {
  const parsedV2 = BackendTargetKeyV2Schema.safeParse(entry);
  if (parsedV2.success) {
    return parsedV2.data;
  }

  const parsed = BackendTargetKeySchema.safeParse(entry);
  if (parsed.success) {
    const backendTarget = parseBackendTargetKey(parsed.data);
    if (backendTarget.kind === 'builtInAgent' && backendTarget.agentId === 'customAcp') {
      return null;
    }
    return parsed.data;
  }

  if (entry === 'customAcp') {
    return null;
  }

  const settingsBackendId = getAgentCatalogDefinition(entry)?.settingsBackendId?.trim();
  if (settingsBackendId) {
    return buildBackendTargetKeyV2({
      kind: 'backend',
      backendId: settingsBackendId,
      configuredBackendId: settingsBackendId,
      sourceKind: 'configured',
    });
  }

  return buildBackendTargetKey({ kind: 'builtInAgent', agentId: entry });
}

export function normalizeBackendTargetKeysFromCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => normalizeBackendTargetKeyFromInput(entry))
    .filter((entry): entry is string => Boolean(entry));
}

export function parseSingleBackendTargetFromFlag(value: string | null): BackendTargetRefV1 | null {
  const backendTargetKeys = normalizeBackendTargetKeysFromCsv(value);
  if (backendTargetKeys.length !== 1) {
    return null;
  }

  return convertBackendTargetRefV2ToV1(readBackendTargetRefV2(backendTargetKeys[0]));
}
