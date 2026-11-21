import { describe, expect, it } from 'vitest';
import { definePlugin, DeploymentTargetPreparationBaseV1ProtocolSchema, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as entry from './index.js';

const credentialRef = { service: { pluginId: 'happier.machine.railway', localId: 'railway-account' }, accountId: 'connected' };
const placement = { serverId: 'home', accountId: 'owner', machineId: 'daemon', installationId: 'installation' };

describe('Railway managed runtime registered with the SDK host', () => {
  it.each([
    ['postgresql', 'DATABASE_URL'],
    ['mysql', 'MYSQL_URL'],
  ] as const)('discovers the exact %s database and refuses reads before reaching a native driver',
    async (engine, privateVariable) => {
      const preparation = DeploymentTargetPreparationBaseV1ProtocolSchema.parse({
        v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
        targetLinkId: 'railway-link', expectedTargetLinkRevision: 1, credentialRef,
        credentialPrincipal: { kind: 'account', accountId: 'owner', target: { kind: 'account', account: credentialRef },
          purpose: { consumer: { pluginId: entry.manifest.id, localId: engine }, purpose: 'cloud-api' } },
        providerIdentity: { providerAccountId: 'project-one', providerResourceId: 'database-one', providerEnvironment: 'railway-env' },
        providerEnvironment: { kind: 'native', selection: { projectId: 'project-one', environmentId: 'railway-env', serviceId: 'database-one' } },
      });
      const target = { kind: 'managed_deployment' as const,
        environment: { serverId: 'home', projectSourceId: 'source', environmentId: 'environment' },
        targetLinkId: 'railway-link', contribution: { pluginId: entry.manifest.id, contributionId: engine },
        platformProjectId: 'database-one', branchId: 'railway-env' };
      const calls: unknown[] = [];
      const http = createPluginHttpFixture({ async request(request) {
        calls.push(JSON.parse(new TextDecoder().decode(request.body)).variables);
        expect(request.credentialBinding).toMatchObject({ kind: 'connectedAccountPurpose', purpose: 'cloud-api' });
        return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ data: {
          variablesForServiceDeployment: {
            [privateVariable]: engine + '://privileged:private-password@database.railway.internal/railway',
          },
        } })) };
      } });
      const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
      try {
        const runtime = kit.registration('deploymentTargets', engine);
        if (!runtime) throw new Error('No registered managed database');
        const probe = definePlugin({ id: 'test.railway-database', version: '0.0.0', actions: { probe: {
          title: 'Probe native host adapter', execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
          scopes: ['global'], surfaces: ['cli'], dangerLevel: 'safe', readOnly: true,
          async run(_input: JsonValue, context: PluginAccountActionContext): Promise<JsonValue> {
            const listing = await runtime.listTargets({ preparation, target, placement }, context);
            await expect(runtime.open({ preparation, target: { ...target, database: 'railway' }, access: 'read', placement }, context))
              .rejects.toMatchObject({ code: 'database_transport_unavailable' });
            return JSON.parse(JSON.stringify(listing));
          },
        } } });
        const runner = await createPluginTestkit({ manifest: probe.manifest, module: probe, services: { http } });
        try {
          const result = await runner.invokeAction('probe', {});
          expect(result).toMatchObject({ targets: [{ engine, target: { ...target, database: 'railway' } }] });
          expect(JSON.stringify(result)).not.toContain('private-password');
          const coordinates = { projectId: 'project-one', environmentId: 'railway-env', serviceId: 'database-one' };
          expect(calls).toEqual([coordinates]);
        } finally { await runner.dispose(); }
      } finally { await kit.dispose(); }
    });
});
