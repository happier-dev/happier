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

describe('Railway read-role endpoint', () => {
  const coordinates = { projectId: 'project-one', environmentId: 'railway-env', serviceId: 'database-one' };
  const scope = (selection: Readonly<Record<string, string>>) => DeploymentTargetPreparationBaseV1ProtocolSchema.parse({
    v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
    targetLinkId: 'railway-link', expectedTargetLinkRevision: 1, credentialRef,
    credentialPrincipal: { kind: 'account', accountId: 'owner', target: { kind: 'account', account: credentialRef },
      purpose: { consumer: { pluginId: entry.manifest.id, localId: 'postgresql' }, purpose: 'cloud-api' } },
    providerIdentity: { providerAccountId: 'project-one', providerResourceId: 'database-one', providerEnvironment: 'railway-env' },
    providerEnvironment: { kind: 'native', selection },
  });

  async function readEndpoint(engine: 'postgresql' | 'mysql', proxies: unknown[], selection: Readonly<Record<string, string>> = coordinates) {
    const calls: Array<{ field: string; variables: unknown }> = [];
    const http = createPluginHttpFixture({ async request(request) {
      const body = JSON.parse(new TextDecoder().decode(request.body));
      const field = String(body.query).includes('tcpProxies') ? 'tcpProxies' : 'variablesForServiceDeployment';
      calls.push({ field, variables: body.variables });
      const data = field === 'tcpProxies' ? { tcpProxies: proxies } : { variablesForServiceDeployment: {
        [engine === 'postgresql' ? 'DATABASE_URL' : 'MYSQL_URL']: `${engine}://privileged:private-password@database.railway.internal:${engine === 'postgresql' ? 5432 : 3306}/railway?sslmode=disable`,
      } };
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ data })) };
    } });
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
    try {
      const runtime = kit.registration('deploymentTargets', engine);
      if (!runtime?.readRoleEndpoint) throw new Error('No read-role endpoint');
      const read = runtime.readRoleEndpoint.bind(runtime);
      const target = { kind: 'managed_deployment' as const,
        environment: { serverId: 'home', projectSourceId: 'source', environmentId: 'environment' },
        targetLinkId: 'railway-link', contribution: { pluginId: entry.manifest.id, contributionId: engine },
        platformProjectId: 'database-one', branchId: 'railway-env', database: 'railway' };
      const probe = definePlugin({ id: 'test.railway-endpoint', version: '0.0.0', actions: { probe: {
        title: 'Probe read endpoint', execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
        scopes: ['global'], surfaces: ['cli'], dangerLevel: 'safe', readOnly: true,
        async run(_input: JsonValue, context: PluginAccountActionContext): Promise<JsonValue> {
          try { return { ok: true, endpoint: { ...await read({ preparation: scope(selection), target }, context) } }; }
          catch (error) { return { ok: false, code: (error as { code?: string }).code ?? 'unknown', message: (error as Error).message }; }
        },
      } } });
      const runner = await createPluginTestkit({ manifest: probe.manifest, module: probe, services: { http } });
      try { return { result: await runner.invokeAction('probe', {}), calls }; }
      finally { await runner.dispose(); }
    } finally { await kit.dispose(); }
  }

  it.each([
    ['postgresql', 5432, 'postgresql://shuttle.proxy.rlwy.net:41234/railway'],
    ['mysql', 3306, 'mysql://shuttle.proxy.rlwy.net:41234/railway'],
  ] as const)('contributes the exact %s service’s public TCP proxy, credential-free and encrypted but unverified',
    async (engine, applicationPort, connectionString) => {
      const { result, calls } = await readEndpoint(engine, [
        { domain: 'other.proxy.rlwy.net', proxyPort: 40000, applicationPort: 8080 },
        { domain: 'shuttle.proxy.rlwy.net', proxyPort: 41234, applicationPort },
      ]);
      expect(result).toEqual({ ok: true, endpoint: { connectionString, trust: 'encrypted_unverified' } });
      expect(JSON.stringify(result)).not.toContain('private-password');
      expect(calls).toEqual([
        { field: 'variablesForServiceDeployment', variables: coordinates },
        { field: 'tcpProxies', variables: { serviceId: 'database-one', environmentId: 'railway-env' } },
      ]);
    });

  it('tells the person to turn on Public Networking when the service has no database proxy', async () => {
    const { result } = await readEndpoint('postgresql', [{ domain: 'web.proxy.rlwy.net', proxyPort: 40000, applicationPort: 8080 }]);
    expect(result).toMatchObject({ ok: false, code: 'database_public_networking_required',
      message: expect.stringContaining('Public Networking') });
  });

  it('refuses a service selected from another Railway environment without calling Railway', async () => {
    const { result, calls } = await readEndpoint('postgresql', [], { ...coordinates, environmentId: 'other-env' });
    expect(result).toMatchObject({ ok: false, code: 'target_mismatch' });
    expect(calls).toEqual([]);
  });
});
