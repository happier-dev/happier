import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';

import * as persistence from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { commitActiveAcpCatalog, getActiveAccountSettingsSnapshotLifetimeToken, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { AgentRuntimeRunnerBootstrapV1Schema } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { withRealForegroundAdmissionFixture } from './foregroundAdmission.testkit';
import { ForegroundAgentRuntimeAdmissionRequestV1Schema } from './foregroundAdmissionContract';

afterEach(() => vi.restoreAllMocks());

describe('Custom ACP foreground instance admission', () => {
  it('retains each exact configured definition through the real foreground bootstrap and refuses deleted or mismatched choices', async () => {
    await withRealForegroundAdmissionFixture({ runtimeOptions: { pluginIds: ['happier.agent.custom-acp'] } }, async fixture => {
      // Persistence is the OS boundary; Account/catalog admission stays real.
      const credentials = { token: 'custom-acp-foreground', encryption: null } as const;
      vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
      const definitions = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: ['definition-a', 'definition-b'].map(id => ({
        id, name: id, title: id, command: `command-${id}`, args: [id], env: {}, capabilities: {}, createdAt: 1, updatedAt: 1,
      })) });
      const publish = (record = definitions) => setActiveAccountSettingsSnapshot({
        source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
        settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
        acpCatalog: { status: 'ready', revision: 1, record },
      });
      publish();
      const agent = [...fixture.runtime.registry.contributes.agentDefinitionsById.values()]
        .find(value => value.identity?.pluginId === CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId);
      if (!agent) throw new Error('Actual Custom ACP contribution missing');
      const choice = (definitionId: string, describedDefinitionId = definitionId) => ({
        agentId: agent.id,
        backendTarget: { kind: 'backend' as const, backendId: agent.id, sourceKind: 'built_in' as const },
        agentTarget: { kind: 'agent' as const, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId },
        runtimeDescriptorV1: { v: 1 as const, agentId: agent.id, agent: { definitionId: describedDefinitionId } },
      });
      const { machineId: _machineId, ...wireRequest } = fixture.request();
      for (const definition of definitions.definitions) {
        const selected = choice(definition.id);
        expect(ForegroundAgentRuntimeAdmissionRequestV1Schema.safeParse({ ...wireRequest, ...selected }).success).toBe(true);
        const admitted = await fixture.prepare(selected);
        expect(admitted).toMatchObject({ ok: true });
        if (!admitted.ok) throw new Error(admitted.error.code);
        const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(admitted.prepared.authorization.bootstrapFilePath, 'utf8')));
        expect(bootstrap.launch?.runtimeDescriptorV1).toEqual(selected.runtimeDescriptorV1);
        await admitted.prepared.cleanup();
      }
      expect(await fixture.prepare(choice('definition-a', 'definition-b'))).toMatchObject({ ok: false });
      expect(commitActiveAcpCatalog({
        scopeKey: resolveAccountSettingsScopeKey(credentials),
        lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
        catalog: { status: 'ready', revision: 2, record: { v: 1, definitions: [] } },
      })).toBe(true);
      expect(await fixture.prepare(choice('definition-a'))).toMatchObject({ ok: false });
    });
  });
});
