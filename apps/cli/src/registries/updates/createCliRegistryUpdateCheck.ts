import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';
import { randomUUID } from 'node:crypto';
import { createSkillActionExecuteV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionOperations';
import type { StoredCredentials } from '@/persistence';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { createCliMcpServerStore, createCliMcpServerStoreForOperation } from '@/settings/mcp/mcpServerStore';
import { createMcpRegistryUpdateTracker } from '@/mcp/servers/registryUpdateTracker';
import { createCliAcpCatalogStore } from '@/agent/acp/catalog/acpCatalogStore';
import { createAgentRegistryUpdateTracker } from '@/agent/acp/catalog/registry/agentRegistryUpdateTracker';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { runWithServerHttpBaseUrl, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliRegistryHostV1 } from '../createCliRegistryHost';
import { createRegistryUpdateCheck } from './registryUpdateTracker';
import { createSkillsUpdateTracker } from './trackers/skillsUpdateTracker';

/** One composition for manual Actions and the daemon's existing update gate. */
export function createCliRegistryUpdateCheck(input: Readonly<{
  credentials: StoredCredentials; serverId?: string; serverHttpBaseUrl?: string; signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1;
  secretSources?: TargetSecretSourcesV1;
}>) {
  const baseUrl = input.operationContext?.serverHttpBaseUrl ?? input.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  return runWithServerHttpBaseUrl(baseUrl, () => {
    const account = createCliApprovalsArtifactStore({ credentials: input.credentials, serverId: input.serverId,
      operationContext: input.operationContext });
    const registry = createCliRegistryHostV1({ ...input, port: account.promptLibraryStore.organization });
    const skills = createSkillActionExecuteV1({ store: account.promptLibraryStore, skillRules: account.skillRules, randomId: randomUUID,
      readRegistryItem: registry.readRegistryItem, readRegistrySource: registry.readRegistrySource,
      fetchRegistrySkillFiles: registry.filesForPointer, readLinkSkills: registry.readLinkSkills, fetchLinkSkillFiles: registry.fetchLinkSkillFiles,
      // Update operations never create skills or write Session selection.
      includeInSession: async () => { throw new Error('registry_update_cannot_include_in_session'); },
    });
    const mcpStore = input.operationContext
      ? createCliMcpServerStoreForOperation({ operationContext: input.operationContext, serverId: input.serverId, signal: input.signal })
      : createCliMcpServerStore({ credentials: input.credentials, serverId: input.serverId, signal: input.signal });
    const checker = createRegistryUpdateCheck({ trackers: [createSkillsUpdateTracker({ execute: skills, signal: input.signal }),
      createMcpRegistryUpdateTracker({ store: mcpStore }),
      createAgentRegistryUpdateTracker({ store: createCliAcpCatalogStore(input) })],
      ctx: registry.fetchContext, admitSource: registry.fetchContext.admitSource, readSources: registry.readSources });
    return {
      checkNow: (filter?: Parameters<typeof checker.checkNow>[0]) => runWithServerHttpBaseUrl(baseUrl, () => checker.checkNow(filter)),
      runBackgroundAutoUpdateCheck: () => runWithServerHttpBaseUrl(baseUrl, () => checker.runBackgroundAutoUpdateCheck()),
    };
  });
}
