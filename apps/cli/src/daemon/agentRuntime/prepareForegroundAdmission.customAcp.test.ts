import { readFile } from 'node:fs/promises';
import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';

import * as persistence from '@/persistence';
import { configuration } from '@/configuration';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { commitActiveAcpCatalog, getActiveAccountSettingsSnapshotLifetimeToken, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { AgentRuntimeRunnerBootstrapV1Schema } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { projectResolvedAgentBackendTarget } from '@/session/creation/resolveSessionCreationAgentTarget';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { withRealForegroundAdmissionFixture } from './foregroundAdmission.testkit';
import { ForegroundAgentRuntimeAdmissionRequestV1Schema } from './foregroundAdmissionContract';

afterEach(() => vi.restoreAllMocks());

describe('Custom ACP foreground instance admission', () => {
  it('retains each exact configured definition through the real foreground bootstrap and refuses deleted or mismatched choices', async () => {
    await withRealForegroundAdmissionFixture({ runtimeOptions: { pluginIds: ['happier.agent.custom-acp'] } }, async fixture => {
      // Persistence is the OS boundary; Account/catalog admission stays real.
      const credentials = { token: 'custom-acp-foreground', encryption: null } as const;
      vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
      const home = fastify();
      let projectCensusObserved = false;
      const definitions = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: ['definition-a', 'definition-b'].map(id => ({
        id, name: id, title: id, launch: { kind: 'command' as const, command: `command-${id}`, args: [id] }, env: {}, capabilities: {}, createdAt: 1, updatedAt: 1,
      })) });
      let catalogRecord = definitions;
      let catalogRevision = 1;
      // Home's complete census proves this ordinary directory is not an accepted Project.
      home.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 0 }));
      home.get('/v1/account/encryption/currentness', async () => ({
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
      }));
      home.get(ACP_CATALOG_ROWS_ROUTE_V1, async request => {
        expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
        return AcpCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: catalogRevision,
          content: { t: 'plain', v: catalogRecord } });
      });
      home.post(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, async request => {
        expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
        projectCensusObserved = true;
        return ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [] });
      });
      await home.ready();
      const restoreAxios = installAxiosFastifyAdapter({ app: home, origin: new URL(configuration.serverUrl).origin });
      try {
        const publish = (record = definitions) => setActiveAccountSettingsSnapshot({
          source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, loadedAtMs: 1,
          settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
          acpCatalog: { status: 'ready', revision: 1, record },
        });
        publish();
        const agent = [...fixture.runtime.registry.contributes.agentDefinitionsById.values()]
          .find(value => value.identity?.pluginId === CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId);
        if (!agent) throw new Error('Actual Custom ACP contribution missing');
        const choice = (definitionId: string, describedDefinitionId = definitionId) => {
          const agentTarget = { kind: 'agent' as const, identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId };
          return {
            agentId: agent.id,
            backendTarget: projectResolvedAgentBackendTarget(agentTarget, agent.id),
            agentTarget,
            runtimeDescriptorV1: { v: 1 as const, agentId: agent.id, agent: { definitionId: describedDefinitionId } },
          };
        };
        const { machineId: _machineId, ...wireRequest } = fixture.request();
        for (const definition of definitions.definitions) {
          const selected = choice(definition.id);
          const parsed = ForegroundAgentRuntimeAdmissionRequestV1Schema.safeParse({ ...wireRequest, ...selected });
          expect(parsed.success, parsed.success ? undefined : parsed.error.message).toBe(true);
          const admitted = await fixture.prepare(selected);
          expect(admitted.ok, admitted.ok ? undefined : JSON.stringify(admitted.error)).toBe(true);
          if (!admitted.ok) throw new Error(admitted.error.code);
          const bootstrap = AgentRuntimeRunnerBootstrapV1Schema.parse(JSON.parse(await readFile(admitted.prepared.authorization.bootstrapFilePath, 'utf8')));
          expect(bootstrap.launch?.runtimeDescriptorV1).toEqual(selected.runtimeDescriptorV1);
          await admitted.prepared.cleanup();
        }
        expect(projectCensusObserved).toBe(true);
        expect(await fixture.prepare(choice('definition-a', 'definition-b'))).toMatchObject({ ok: false });
        catalogRecord = { v: 1, definitions: [] };
        catalogRevision = 2;
        expect(commitActiveAcpCatalog({
          scopeKey: resolveAccountSettingsScopeKey(credentials),
          lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
          catalog: { status: 'ready', revision: catalogRevision, record: catalogRecord },
        })).toBe(true);
        expect(await fixture.prepare(choice('definition-a'))).toMatchObject({ ok: false });
      } finally {
        withdrawActiveProjectAccountRowsSnapshot();
        restoreAxios();
        await home.close();
      }
    });
  });
});
