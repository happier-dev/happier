import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { DeploymentEnvironmentCreateIntentInputV1Schema, type ActionExecutorContext } from '@happier-dev/protocol';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createRegistryHostV1, DeploymentTemplateV1Schema, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1,
    type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { createDeploymentSocketHome } from '@/testkit/deploymentSocketHome.testkit.mjs';
import { db } from '@/storage/db';
import { withConfiguredDaemonTestHome } from '../../../../../../cli/src/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createDaemonDeploymentActionDeps } from '../../../../../../cli/src/deployments/createDaemonDeploymentActionDeps';
import { createS0DeploymentDaemonIngress, readS0ControllerCredentials } from '../../../../../../cli/src/deployments/deploymentDaemonIngress.testkit';
import { createCliActionExecutorFromCredentials } from '../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createCliPromptLibraryStore } from '../../../../../../cli/src/settings/prompts/promptLibraryStore';
import { adoptServerProfileHomeConnectionDescriptor } from '../../../../../../cli/src/server/serverProfiles';
import { configuration } from '../../../../../../cli/src/configuration';
import { runWithServerHttpBaseUrl } from '../../../../../../cli/src/api/client/serverHttpBaseUrl';
import { createFilesystemEffectAdmission } from '../../../../../../cli/src/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import * as installationStore from '../../../../../../cli/src/daemon/identity/store';
import { resetInMemoryAccountSettingsContextForTests } from '../../../../../../cli/src/settings/accountSettings/bootstrapAccountSettingsContext';
import { logger } from '../../../../../../cli/src/ui/logger';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetInMemoryAccountSettingsContextForTests(); });

it('publishes approved catalog Create content and generated Secrets only for the admitted Project owner', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'catalog-create-approval-', env: {
        HAPPIER_FEATURE_DEPLOYMENTS__ENABLED: '1', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
    } }, async () => {
        const requests: Array<{ method: string; path: string; status: number }> = [];
        const artifactSecretCounts: number[] = [];
        const refusals: Array<Record<string, unknown>> = [];
        const phaseLog = vi.spyOn(logger, 'warnLocalFile');
        const home = await createDeploymentSocketHome({ configureApp: app => {
            app.addHook('onRequest', async request => {
                if (request.method === 'POST' && request.url === '/v1/artifacts')
                    artifactSecretCounts.push(await db.savedSecretResource.count());
            });
            app.addHook('onResponse', (request, reply, done) => {
                requests.push({ method: request.method, path: request.url, status: reply.statusCode }); done();
            });
            app.addHook('onSend', async (request, reply, payload) => {
                if (reply.statusCode < 400 || typeof payload !== 'string') return payload;
                const body: unknown = JSON.parse(payload);
                if (body && typeof body === 'object') refusals.push({ path: request.url,
                    ...Object.fromEntries(Object.entries(body).filter(([key]) =>
                        ['error', 'authorizationRefusal', 'phase', 'requiredFact', 'remedy'].includes(key))) });
                return payload;
            });
        } });
        let ingress: Awaited<ReturnType<typeof createS0DeploymentDaemonIngress>> | undefined;
        try {
            await adoptServerProfileHomeConnectionDescriptor({ descriptor: { v: 1, homeServerIdentityId: home.serverId,
                canonicalServerUrl: home.baseUrl, revision: 1, endpoints: [{ kind: 'https', url: home.baseUrl }] },
                expectedProfileId: configuration.activeServerId, createIfMissing: true, observation: 'exact' });
            const credentials = readS0ControllerCredentials(home);
            vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, createdAt: 1,
                installationId: home.installationId, publicKey: Buffer.from(home.keys.publicKey).toString('base64url'),
                privateKey: Buffer.from(home.keys.secretKey).toString('base64url') });
            const simpleApp = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'PostgreSQL', compose: {
                document: 'services:\n  postgres:\n    image: postgres:17\n', profiles: [], services: ['postgres'] },
                variables: [], generatedSecrets: [], domains: [], volumes: [] });
            const bundled: unknown = JSON.parse(await readFile(new URL(
                '../../../../../../../packages/plugins/deployment-templates/resources/registry/apps.json', import.meta.url), 'utf8'));
            if (!bundled || typeof bundled !== 'object' || !('apps' in bundled) || !Array.isArray(bundled.apps))
                throw new Error('Expected bundled catalog');
            const postgres: unknown = bundled.apps.find((entry: { itemId: string }) => entry.itemId === 'postgresql');
            if (!postgres || typeof postgres !== 'object' || !('app' in postgres)) throw new Error('Expected bundled PostgreSQL');
            const source: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
                url: 'https://catalog.example.test/apps.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
            const catalog = { schemaVersion: 1, apps: [
                { itemId: 'postgresql', app: DeploymentTemplateV1Schema.parse(postgres.app) },
                { itemId: 'minimal-postgresql', app: simpleApp },
            ] };
            // Only the third-party catalog HTTP boundary is substituted.
            const fetchHome = globalThis.fetch;
            vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) =>
                String(url) === source.url ? Response.json(catalog) : fetchHome(url, options));
            const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
                getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
                getText: async () => { throw new Error('No catalog text'); }, getBytes: async () => { throw new Error('No catalog bytes'); },
            } });
            await runWithServerHttpBaseUrl(home.baseUrl, async () => {
                const library = createCliPromptLibraryStore({ credentials });
                const { origin: _origin, removable: _removable, ...sourceRow } = source;
                const snapshot = await library.readSourceSnapshot();
                const written = await library.writeRecord({ record: { key: 'registry-sources',
                    value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } }, expectedRevision: 'absent',
                    sourceSettingsVersion: snapshot.version });
                expect(written).toMatchObject({ status: 'updated' });
            });
            const identity = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => home.serverId,
                resolveHostIdentity: async () => ({ custodianAccountId: home.accountId, machineId: home.machineId,
                    installationId: home.installationId }) });
            const resolveRequesterIdentity: Parameters<typeof createDaemonDeploymentActionDeps>[0]['resolveRequesterIdentity'] = async context => {
                const requester = await identity.resolveActionRequester!(context);
                try { return requester.identity; } finally { await requester.dispose(); }
            };
            ingress = await createS0DeploymentDaemonIngress({ home, resolveDeploymentRequesterIdentity: resolveRequesterIdentity,
                createDeploymentActionDeps: requester => createDaemonDeploymentActionDeps({ credentials: requester?.credentials ?? credentials,
                    serverId: home.serverId, serverHttpBaseUrl: home.baseUrl, machineId: home.machineId, resolveRequesterIdentity,
                    ...(requester ? { savedSecretOperationContext: requester.savedSecretOperationContext } : {}),
                    runtime: { async acquire() { throw new Error('Unlinked catalog creation has no native deployment'); } } }),
            });
            const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
                machineId: home.machineId, serverId: home.serverId, serverIdentityId: home.serverId, serverApiUrl: home.baseUrl });
            // One Home owns the complete approval journey; its requester publication
            // and daemon custody stay live across the distinct creation shapes.
            for (const ownership of ['foreignOwner', 'generatedSecret', 'owner', 'firstTarget'] as const) {
                const environmentCount = await db.deploymentEnvironment.count();
                const secretCount = await db.savedSecretResource.count();
                const linkCount = await db.deploymentTargetLink.count();
                const itemId = ownership === 'generatedSecret' || ownership === 'foreignOwner' ? 'postgresql' : 'minimal-postgresql';
                const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
                    sourceId: source.id, kind: 'app', itemId })).item;
                if (selected.payload.kind !== 'app') throw new Error('Expected catalog App');
                const input = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ serverId: home.serverId, mode: 'apply',
                    requestKey: randomUUID(), name: 'Approved PostgreSQL', newProject: { name: 'Approved Project', requestKey: randomUUID(),
                        owner: { kind: 'account', accountId: home.accountId } }, protection: 'nonProduction', purpose: 'standard',
                    deployerMode: 'managers', controllerMachineId: home.machineId, buildMachineId: home.machineId,
                    definition: { from: 'catalogApp', templateRef: { sourceId: source.id, itemId,
                        version: selected.summary.version!, ref: selected.payload.ref } },
                    bindings: ownership === 'generatedSecret' || ownership === 'foreignOwner' ? [
                        { purpose: 'variable', name: 'DB_USER', phase: 'runtime', source: { kind: 'value', value: 'happier' } },
                        { purpose: 'variable', name: 'DB_NAME', phase: 'runtime', source: { kind: 'value', value: 'app' } },
                        { purpose: 'variable', name: 'DB_PASSWORD', phase: 'runtime', source: { kind: 'generated', key: 'DB_PASSWORD' } },
                    ] : [],
                    ...(ownership === 'generatedSecret' || ownership === 'foreignOwner'
                        ? { generatedSecretAudience: { accountGrants: [], teamGrants: [], groupGrants: [] } } : {}),
                    ...(ownership === 'firstTarget' ? { firstTargetLink: { machines: [{ machineId: home.machineId,
                        installationId: home.installationId }] } } : {}) });
                const context = { surface: 'cli', authority: 'present_user', serverId: home.serverId, serverIdentityId: home.serverId,
                    runtimeAccountId: home.accountId, actionRequestId: randomUUID() } satisfies ActionExecutorContext;
                if (ownership === 'foreignOwner') {
                    const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
                    const beforeMint = requests.length;
                    const response = await fetch(`${home.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1('deployments.environments.create')}`, {
                        method: 'POST', headers: { Authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ v: 1, machineId: home.machineId, envelope: ExternalActionRequestEnvelopeV1Schema.parse({
                            v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId: home.machineId },
                            input: { ...input, newProject: { ...input.newProject!, owner: { kind: 'account', accountId: foreign.id } } },
                        }) }),
                    });
                    expect(response.status).toBe(403);
                    expect(requests.slice(beforeMint).filter(request => request.method !== 'GET'
                        && (request.path.startsWith('/v1/artifacts') || request.path.includes('saved-secret') || request.path.startsWith('/v1/account/settings')
                            || request.path === '/v1/deployments/environments'))).toEqual([]);
                    expect(await db.deploymentEnvironment.count()).toBe(environmentCount);
                    expect(await db.savedSecretResource.count()).toBe(secretCount);
                    continue;
                }
                await runWithServerHttpBaseUrl(home.baseUrl, async () => {
                    const pending = await executor.execute('deployments.environments.create', input, context);
                    expect(pending.ok, pending.ok ? '' : JSON.stringify({ ownership, errorCode: pending.errorCode,
                        error: pending.error, failureCause: pending.failureCause, requests,
                        phases: phaseLog.mock.calls.filter(([message]) => message === '[external-action-phase]')
                            .map(([, diagnostic]) => diagnostic) })).toBe(true);
                    expect(pending).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                    if (!pending.ok || !pending.result || typeof pending.result !== 'object' || !('artifactId' in pending.result))
                        throw new Error('Expected the real approval Artifact');
                    expect(await db.deploymentEnvironment.count()).toBe(environmentCount);
                    expect(await db.savedSecretResource.count()).toBe(secretCount);
                    const beforeApproval = requests.length;
                    const beforeContent = artifactSecretCounts.length;
                    const approved = await executor.execute('approval.request.decide', { artifactId: pending.result.artifactId, decision: 'approve' },
                        { ...context, actionRequestId: randomUUID() });
                    expect(approved.ok, approved.ok ? '' : JSON.stringify({ errorCode: approved.errorCode,
                        error: approved.error, failureCause: approved.failureCause })).toBe(true);
                    const effects = requests.slice(beforeApproval);
                    if (ownership === 'generatedSecret') {
                        expect(await db.savedSecretResource.count()).toBe(secretCount + 1);
                        expect(artifactSecretCounts.slice(beforeContent)).toContain(secretCount + 1);
                    }
                    expect(effects.filter(request => request.path === '/v1/artifacts' && request.method === 'POST'))
                        .toContainEqual({ method: 'POST', path: '/v1/artifacts', status: 200 });
                    const execution = approved.ok && approved.result && typeof approved.result === 'object'
                        && 'execution' in approved.result ? approved.result.execution : undefined;
                    expect(execution, JSON.stringify({ ownership, effects, refusals, failure: execution && typeof execution === 'object'
                        ? Object.fromEntries(Object.entries(execution).filter(([key]) => ['ok', 'errorCode', 'failureCause'].includes(key)))
                        : undefined })).toMatchObject({ ok: true });
                    expect(effects).toContainEqual({ method: 'POST', path: '/v1/deployments/environments', status: 200 });
                    const publication = effects.findIndex(request => request.method === 'POST' && request.path === '/v1/artifacts');
                    const environmentCreation = effects.findIndex(request => request.method === 'POST'
                        && request.path === '/v1/deployments/environments');
                    expect(effects.slice(publication + 1, environmentCreation).filter(request => request.method === 'GET'
                        && request.path.startsWith('/v1/artifacts/'))).toEqual([]);
                    expect(await db.deploymentEnvironment.count()).toBe(environmentCount + 1);
                    expect(await db.deploymentTargetLink.count()).toBe(linkCount + (ownership === 'firstTarget' ? 1 : 0));
                });
            }
        } finally { await ingress?.close(); await home.close(); }
    });
}, 300_000);
