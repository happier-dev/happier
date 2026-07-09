import type { ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '../connectedServiceChildEnvironment';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';
import { resolveConnectedServiceTargetMaterializedRoot } from './resolveConnectedServiceTargetMaterializedRoot';

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringRecord(value: unknown): Readonly<Record<string, string>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export function readConnectedServiceRuntimeAuthSelectionMaterializedContext(
  runtimeAuthSelection: unknown,
): Readonly<{
  targetMaterializedEnv: Readonly<Record<string, string>> | null;
  targetMaterializedRoot: string | null;
}> {
  if (!runtimeAuthSelection || typeof runtimeAuthSelection !== 'object' || Array.isArray(runtimeAuthSelection)) {
    return { targetMaterializedEnv: null, targetMaterializedRoot: null };
  }
  const record = runtimeAuthSelection as Record<string, unknown>;
  return {
    targetMaterializedEnv: asStringRecord(record.targetMaterializedEnv),
    targetMaterializedRoot: asNonEmptyString(record.targetMaterializedRoot),
  };
}

export function resolveConnectedServiceSwitchTargetMaterializedContext(input: Readonly<{
  agentId: CatalogAgentId;
  baseDir: string;
  inheritedEnv: Readonly<Record<string, string>> | null;
  effectiveIdentity: ConnectedServiceMaterializationIdentityV1 | null;
  runtimeAuthSelection?: unknown;
}>): Readonly<{
  targetMaterializedEnv: Readonly<Record<string, string>> | null;
  targetMaterializedRoot: string | null;
}> {
  const inheritedEnv = input.inheritedEnv ?? null;
  const selectionContext = readConnectedServiceRuntimeAuthSelectionMaterializedContext(input.runtimeAuthSelection);
  const selectionRoot = selectionContext.targetMaterializedRoot
    ?? resolveConnectedServiceTargetMaterializedRoot({
      agentId: input.agentId,
      targetMaterializedEnv: selectionContext.targetMaterializedEnv,
    });
  if (selectionRoot) {
    return {
      targetMaterializedEnv: {
        ...(inheritedEnv ?? {}),
        ...(selectionContext.targetMaterializedEnv ?? {}),
        [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: selectionRoot,
      },
      targetMaterializedRoot: selectionRoot,
    };
  }

  const inheritedRoot = resolveConnectedServiceTargetMaterializedRoot({
    agentId: input.agentId,
    targetMaterializedEnv: inheritedEnv,
  });
  const reconstructedRoot = input.effectiveIdentity
    ? resolveConnectedServiceMaterializedRootDir({
        baseDir: input.baseDir,
        agentId: input.agentId,
        materializationKey: input.effectiveIdentity.id,
      })
    : null;

  const targetMaterializedEnv = inheritedRoot || !reconstructedRoot
    ? inheritedEnv
    : {
        ...(inheritedEnv ?? {}),
        [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: reconstructedRoot,
      };

  return {
    targetMaterializedEnv,
    targetMaterializedRoot: resolveConnectedServiceTargetMaterializedRoot({
      agentId: input.agentId,
      targetMaterializedEnv,
    }),
  };
}
