import type { ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/backends/types';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '../connectedServiceChildEnvironment';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';
import { resolveConnectedServiceTargetMaterializedRoot } from './resolveConnectedServiceTargetMaterializedRoot';

export function resolveConnectedServiceSwitchTargetMaterializedContext(input: Readonly<{
  agentId: CatalogAgentId;
  baseDir: string;
  inheritedEnv: Readonly<Record<string, string>> | null;
  effectiveIdentity: ConnectedServiceMaterializationIdentityV1 | null;
}>): Readonly<{
  targetMaterializedEnv: Readonly<Record<string, string>> | null;
  targetMaterializedRoot: string | null;
}> {
  const inheritedEnv = input.inheritedEnv ?? null;
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
