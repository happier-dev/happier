import { describe, expect, it, onTestFinished } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '@/plugins/projection/registry/resolveBuiltInContributions';
import { projectAgentConnectedAccountLaunchCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { OPENCODE_PLUGIN } from '../../../../../../packages/plugins/opencode/src/manifest';
import { CODEX_PLUGIN } from '../../../../../../packages/plugins/codex/src/manifest';
import { CLAUDE_PLUGIN } from '../../../../../../packages/plugins/claude/src/manifest';
import { parseConnectedServiceBindingSelections } from '../parseConnectedServicesBindings';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from './prepareConnectedAccountRequestAuthForSpawn';
import { assertQualifiedPurposeAuthorityForSelections } from './qualifiedPurposeAuthority';

describe('admitted Agent connected-account purpose declarations', () => {
  it.each([
    ['opencode', 'happier.agent.codex/openai-codex'],
    ['opencode', 'happier.agent.claude/claude-subscription'],
    ['codex', 'happier.agent.codex/openai-codex'],
    ['claude', 'happier.agent.claude/claude-subscription'],
  ])('admits the declared explicit Connected Account for %s / %s', async (agentId, serviceId) => {
    const bindings = { v: 2 as const, bindingsByServiceId: {
      [serviceId]: { source: 'connected' as const, selection: 'profile' as const, profileId: 'fin-keep-r173-account' },
    } };
    const plugin = [OPENCODE_PLUGIN, CODEX_PLUGIN, CLAUDE_PLUGIN]
      .find(candidate => candidate.manifest.id === `happier.agent.${agentId}`);
    if (!plugin) throw new Error('Expected the real Agent plugin');
    const activation = await createPluginTestkit({ manifest: plugin.manifest, module: { activate: plugin.activate } });
    onTestFinished(() => activation.dispose());
    const launch = activation.registration('agents', agentId)?.connectedAccountLaunch;
    if (!launch) throw new Error('Expected declared Connected Account launch facts');
    const contributions = createResolvedContributionRegistry(resolveBuiltInContributions());
    const catalogEntry = projectAgentConnectedAccountLaunchCatalogEntry({
      agentId, pluginId: plugin.manifest.id, connectedAccountLaunch: launch,
      hostAccess: contributions.agentDefinitionsById.get(agentId)?.hostAccess, isCurrent: () => true,
    });
    const snapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
      agentId, bindings, contributions, catalogEntry,
    });
    expect(snapshot, JSON.stringify({ agentId,
      declarations: contributions.agentDefinitionsById.get(agentId)?.richDefinition?.definition.connectedAccounts,
      requestAuthUses: catalogEntry?.connectedAccountRequestAuthUses,
      fileEnvironmentUses: catalogEntry?.connectedAccountFileEnvironmentUses,
      environmentUses: catalogEntry?.connectedAccountEnvironmentUses,
      environmentUnsetUses: catalogEntry?.connectedAccountEnvironmentUnsetUses,
    })).not.toBeNull();
    expect(() => assertQualifiedPurposeAuthorityForSelections({
      selections: parseConnectedServiceBindingSelections(bindings), snapshot,
    })).not.toThrow();
    expect(snapshot?.bindings).toEqual(expect.arrayContaining([expect.objectContaining({
      target: { kind: 'account', account: {
        service: { pluginId: serviceId.split('/')[0], localId: serviceId.split('/')[1] },
        accountId: 'fin-keep-r173-account',
      } },
    })]));
  });
});
