import { setImmediate } from 'node:timers/promises';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRetainedAccountExecutionRuntime } from './accountExecutionRuntime';
import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { DaemonPluginUiTargetedContributionsReadRequestSchema, DaemonPluginUiTargetedContributionsReadResponseSchema,
    DaemonPluginTargetedSourceDeclarationV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { executeAccountPluginAction } from '@/session/actions/executeAccountPluginAction';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';
import { manifest as admittedSourceManifest } from './accountMachineActionIntent.fixture';

const { machineRpc } = vi.hoisted(() => ({ machineRpc: vi.fn() }));
vi.mock('@/session/transport/rpc/machineRpc', async importOriginal => ({
    ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(),
    // The exact Machine RPC transport is the external system boundary. Strict
    // producer/consumer schemas and the whole local invocation stay real.
    callExactMachineRpc: machineRpc,
}));
afterEach(() => vi.restoreAllMocks());

const inputSchema = defineProtocolObject({ key: defineProtocolString() }, { policy: 'closed' });
const resultSchema = defineProtocolObject({ key: defineProtocolString(), machine: defineProtocolLiteral(true) }, { policy: 'closed' });
const protocol = defineContributionProtocol({ id: 'account-machine-read', version: 1, operations: {
    read: { required: true, input: { kind: 'protocolDefined', schema: inputSchema }, resultSchema,
        action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
} });
const provider = definePlugin({ id: 'acme.account-source-provider', version: '1.0.0', actions: {
    read: { title: 'Read provider', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema, resultSchema,
        run: async ({ key }) => ({ key, machine: true as const }) },
}, contributesTo: { 'acme.account-actions': { sources: {
    provider: protocol.contribute({ operations: { read: protocol.operations.read.bind('read') } }),
} }, 'acme.account-admitted': { sources: {
    provider: protocol.contribute({ operations: { read: protocol.operations.read.bind('read') } }),
} } } });

it.each(['direct', 'targeted'] as const)('conditionally reuses admitted Machine source bodies in a retained Account runtime (%s)', async outcome => {
    const app = fastify();
    const endpoint = 'http://account-machine.test';
    const features = registerAccountHomeHttp(app, { accountId: 'owner', serverId: 'account-machine' });
    const { pluginId } = await registerAuthoredAccountActionRelease(app, 'owner', outcome === 'targeted' ? { primary: {
        manifest: admittedSourceManifest, projectRoot: resolve(import.meta.dirname, '../../../../../packages/plugin-sdk/fixtures/account-actions'),
        entryPath: resolve(import.meta.dirname, 'accountMachineActionIntent.fixture.ts'),
    } } : {});
    const manifest = normalizePluginManifestV2(provider.manifest);
    const source = DaemonPluginTargetedSourceDeclarationV1Schema.parse({ manifest: { id: manifest.id, contributes: {
        actions: manifest.contributes.actions, pluginContributionPoints: [],
        targetedPluginContributions: manifest.contributes.targetedPluginContributions.filter(entry => entry.target.pluginId === pluginId), ui: { renderers: [] },
    } }, occurrenceId: 'provider-machine-occurrence', sourceCustody: {
        kind: 'managed', immutableGenerationId: 'provider-machine-generation', installSource: 'archive',
    } });
    const github = normalizePluginManifestV2(JSON.parse(await readFile(resolve(import.meta.dirname,
        '../../../assets/bundled-plugin-manifests/scm-github.json'), 'utf8')));
    const ownSource = DaemonPluginTargetedSourceDeclarationV1Schema.parse({ ...source,
        manifest: { id: pluginId, contributes: { actions: github.contributes.actions.filter(action => action.execution.target === 'daemon'),
            pluginContributionPoints: [], targetedPluginContributions: [], ui: { renderers: [] } } } });
    const body = { status: 'sourceDeclarations', pluginId, sourceDeclarations: [source, ownSource] };
    const parseCount = vi.spyOn(DaemonPluginUiTargetedContributionsReadResponseSchema, 'parse');
    let providerEffects = 0;
    const requests: Parameters<typeof import('@/session/transport/rpc/machineRpc').callExactMachineRpc>[0][] = [];
    machineRpc.mockImplementation(async (request: Parameters<typeof import('@/session/transport/rpc/machineRpc').callExactMachineRpc>[0]) => {
        requests.push(request);
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) {
            // A network response settles on a later turn; keep concurrent readers in flight together.
            await setImmediate();
            const query = DaemonPluginUiTargetedContributionsReadRequestSchema.parse(request.request);
            return query.knownSourceRevision === 'fixture-revision'
                ? { status: 'sourceDeclarationsUnchanged', pluginId, sourceRevision: 'fixture-revision' }
                : JSON.parse(JSON.stringify({ ...body, sourceRevision: 'fixture-revision',
                    sourceDeclarations: body.sourceDeclarations.filter(row => !query.sourcePluginId || row.manifest.id === query.sourcePluginId) }));
        }
        providerEffects++;
        return { ok: true, result: { key: 'provider', machine: true } };
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
    try {
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`,
            encryption: null, credentialProvenance: 'stored_session' as const };
        const context: ActionExecutorContext = {
            surface: outcome === 'targeted' ? 'ui' : 'cli',
            ...(outcome === 'targeted' ? { authority: 'present_user' as const } : {}),
            ...(outcome === 'targeted' ? { actionRequestId: '4d13dc15-d859-4c0e-9abe-d561a12894d5' } : {}),
            runtimeAccountId: 'owner', serverId: 'account-machine', serverIdentityId: 'account-machine',
        };
        const input = { action: { pluginId, localId: 'source' }, input: { key: 'provider' } };
        const host = { token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain' as const, ctx: null,
            serverHttpBaseUrl: endpoint, runtimeActionMachineId: 'selected-machine',
            serverId: 'account-machine', serverIdentityId: 'account-machine' };
        const { deps } = createCliActionExecutorHarness(host);
        const retained = createRetainedAccountExecutionRuntime(() => ({ accountExecution: { credentials, serverUrl: endpoint,
            machineId: 'selected-machine', isCurrent: () => true } }));
        const run = async () => {
            const attempt = await executeAccountPluginAction({ host, deps, accountRuntime: retained, actionId: 'action.invoke', input, context });
            if (!attempt.matched) throw new Error('Expected Account Action placement');
            expect(attempt.result).toMatchObject({ ok: true, result: { key: 'provider', machine: true } });
        };
        const reads = () => requests.filter(r => r.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ).length;
        try {
            await run();
            const cold = reads();
            const coldParses = parseCount.mock.calls.length;
            await run();
            const warm = reads() - cold;
            const warmParses = parseCount.mock.results.slice(coldParses).filter(r => r.type === 'return' && r.value.status === 'sourceDeclarations').length;
            const beforeParses = parseCount.mock.calls.length;
            const before = reads();
            await Promise.all(Array.from({ length: 4 }, run));
            const concurrent = reads() - before;
            console.log('DECL_READ_COUNTS', JSON.stringify({ cold, warm, K: 4, concurrent,
                coldParses, warmParses, concurrentParses: parseCount.mock.results.slice(beforeParses).filter(r => r.type === 'return' && r.value.status === 'sourceDeclarations').length, actions: ownSource.manifest.contributes.actions.length, responseBytes: Buffer.byteLength(JSON.stringify(body)) }));
            expect({ warm, concurrent, warmParses, concurrentParses: parseCount.mock.results.slice(beforeParses).filter(r => r.type === 'return' && r.value.status === 'sourceDeclarations').length }).toEqual({ warm: outcome === 'targeted' ? 4 : 1, concurrent: outcome === 'targeted' ? 4 : 1, warmParses: 0, concurrentParses: 0 });
        } finally { await retained.dispose(); }
        expect(providerEffects).toBe(6);
    } finally { restore(); await app.close(); }
});
