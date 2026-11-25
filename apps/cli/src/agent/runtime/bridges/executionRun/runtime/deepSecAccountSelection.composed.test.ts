import { rm, writeFile } from 'node:fs/promises';
import axios from 'axios';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import type { AgentExecutionRunEvent, AgentExecutionRunOpenRequest, AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedServiceBindingsV2 } from '@happier-dev/protocol';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { ExecutionRunStartRequestBaseSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { bindRequesterSessionCredentialScope } from '@/persistence';
import { reloadConfiguration } from '@/configuration';
import { findCatalogEntry } from '@/agent/catalog/registry';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import type { requestExecutionRunConnectedServicesMaterialization } from '@/daemon/controlClient';
import { resolveExecutionRunConnectedServicesEnv } from './connectedServicesEnv';
import { prepareCodexConnectedAccountLaunchEnvironment } from '../../../../../../../../packages/plugins/codex/src/agent/runtime/connectedAccountKeys';
import { activate, PLUGIN_MANIFEST } from '../../../../../../../../packages/plugins/review-deepsec/src/index';
import { buildGitSnapshot } from '../../../../../../../../packages/plugins/scm-git/src/statusSnapshot';
import { applyExecutionRunChildSelection } from '../../../../../../../ui/sources/components/sessions/runs/launcher/executionRunChildChoice';

const home = await vi.hoisted(async () => {
    const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([
        import('node:fs/promises'), import('node:os'), import('node:path'),
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'happier-deepsec-account-selection-'));
    const previous = process.env.HAPPIER_HOME_DIR;
    process.env.HAPPIER_HOME_DIR = directory;
    return { directory, previous };
});
const transport = vi.hoisted(() => ({
    materialize: vi.fn(), release: vi.fn(async () => ({ ok: true, released: true })),
    credentials: { token: `header.${Buffer.from(JSON.stringify({ sub: 'deepsec-account-selection' })).toString('base64url')}.signature`, encryption: null },
}));
// These are daemon-control and persisted-credential boundaries. Default resolution,
// catalog interpretation, runner preparation and DeepSec execution remain real.
vi.mock('@/daemon/controlClient', async importOriginal => ({
    ...await importOriginal<typeof import('@/daemon/controlClient')>(),
    requestExecutionRunConnectedServicesMaterialization: transport.materialize,
    releaseExecutionRunConnectedServices: transport.release,
}));
vi.mock('@/persistence', async importOriginal => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readStoredCredentials: async () => transport.credentials,
}));

const serviceId = 'happier.agent.codex/openai-codex';
const consumer = { pluginId: 'happier.agent.codex', localId: 'codex' };
const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const activationId = '11111111-1111-4111-8111-111111111111';
const connected = (profileId: string): ConnectedServiceBindingsV2 => ({ v: 2, bindingsByServiceId: {
    [serviceId]: { source: 'connected', selection: 'profile', profileId },
} });

describe('DeepSec consumes the canonical host Account selection', () => {
    let linkedAccount: string | null;
    const homeReads: string[] = [];
    const nativeRequests: Array<Parameters<PluginServices['exec']['run']>[0]> = [];
    beforeEach(() => {
        linkedAccount = 'linked-account';
        homeReads.length = 0;
        nativeRequests.length = 0;
        transport.materialize.mockReset();
        transport.release.mockClear();
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('Unexpected fixture Home request'); }));
        vi.spyOn(axios, 'get').mockImplementation(async input => {
            const url = new URL(String(input));
            homeReads.push(url.pathname);
            if (url.pathname === '/v2/account/settings') return { status: 200, data: {
                content: { t: 'plain', v: {} }, version: 9,
            } };
            if (url.pathname === '/v1/account/encryption/currentness') return { status: 200,
                data: createAccountEncryptionCurrentnessFixture({ settingsVersion: 9 }) };
            if (url.pathname === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) return {
                status: 200, data: { status: 'present', revision: 3, content: { t: 'plain', v: {
                    key: 'purposes', value: { v: 1, bindings: linkedAccount ? [{
                        purpose: { consumer, purpose: 'primary' },
                        target: { kind: 'account', account: { service, accountId: linkedAccount } },
                    }] : [] },
                } } },
            };
            throw new Error(`Unexpected fixture Home path: ${url.pathname}`);
        });
        vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected fixture Home request'));
        bindRequesterSessionCredentialScope(transport.credentials, {
            serverId: 'deepsec-fixture-home', serverHttpBaseUrl: 'https://deepsec-fixture.example',
        });
        transport.materialize.mockImplementation(async (request: Parameters<typeof requestExecutionRunConnectedServicesMaterialization>[0]) => {
            const binding = ConnectedServiceBindingsV2Schema.parse(request.connectedServices).bindingsByServiceId[serviceId];
            if (binding?.source !== 'connected' || binding.selection !== 'profile') throw new Error('Expected selected Account');
            const profileId = binding.profileId;
            return { ok: true, result: { activationId, producedConnectedAccountPurposes: ['primary'],
                env: { CODEX_HOME: `/selected/${profileId}` }, connectedServicesBindings: request.connectedServices,
                registration: { v: 2, activationId, runKey: request.runId, agentId: 'codex',
                    materializationKey: request.runId, connectedServicesBindings: request.connectedServices,
                    connectedServiceSelectionsEnv: {}, sessionDirectory: home.directory,
                    materializedRoot: `/selected/${profileId}` },
            } };
        });
    });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
    afterAll(async () => {
        if (home.previous === undefined) delete process.env.HAPPIER_HOME_DIR;
        else process.env.HAPPIER_HOME_DIR = home.previous;
        reloadConfiguration();
        await rm(home.directory, { recursive: true, force: true });
    });

    async function launch(selection?: ConnectedServiceBindingsV2 | null,
        modelSelection?: Extract<AgentExecutionRunOpenRequest, { kind: 'create' }>['modelSelection']) {
        const resolved = await resolveExecutionRunConnectedServicesEnv({
            runId: 'deepsec-selection', backendId: 'codex', backendSourceKind: 'built_in',
            agentCatalogEntry: findCatalogEntry('codex'), cwd: home.directory,
            ...(selection !== undefined ? { connectedServices: selection } : {}),
        });
        const ambient = { CODEX_HOME: '/machine/native-login',
            ...(selection === null ? {} : { AI_GATEWAY_API_KEY: 'ambient-gateway', OPENAI_API_KEY: 'ambient-key' }) };
        const prepared = prepareCodexConnectedAccountLaunchEnvironment({
            purposes: resolved?.producedConnectedAccountPurposes ?? [],
            launchEnvironment: { values: { ...ambient, ...resolved?.env }, unset: resolved?.unsetEnvKeys ?? [] },
        });
        const unavailable = createUnavailablePluginServices();
        const signal = new AbortController().signal;
        const snapshot = buildGitSnapshot({ projectKey: 'fixture', fetchedAt: 0, rootPath: home.directory,
            statusOutput: `# branch.oid ${'b'.repeat(40)}\u0000# branch.head feature\u00001 .M N... 100644 100644 100644 ${'a'.repeat(40)} ${'a'.repeat(40)} src/auth.ts\u0000`,
            includedNumStatOutput: '', pendingNumStatOutput: '1\t1\tsrc/auth.ts\0' });
        // Only host I/O ports are substituted: no real vendor process or Home is contacted.
        const services: PluginServices = { ...unavailable,
            availability: id => ['exec', 'fs', 'actions'].includes(id) ? { status: 'available' } : unavailable.availability(id),
            fs: { ...unavailable.fs, stat: async () => ({ kind: 'file', size: 1, modifiedAtMs: 1 }) },
            actions: { ...unavailable.actions,
                execute: vi.fn<PluginServices['actions']['execute']>().mockResolvedValue({ success: true, snapshot }) },
            exec: { ...unavailable.exec,
                agentCli: { checkReadiness: async () => ({ launchable: [{ agentId: 'codex' }] }) },
                systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'deepsec-cli' }, executablePath: '/native/deepsec' }) },
                async run(request) {
                    nativeRequests.push(request);
                    if (request.args?.[0] === 'export') {
                        const out = request.args[request.args.indexOf('--out') + 1];
                        if (!out) throw new Error('Missing native export destination');
                        await writeFile(out, '[]', 'utf8');
                    }
                    return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
                        stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
                },
            },
        };
        const unused = async (): Promise<never> => { throw new Error('Unexpected UI or protocol access'); };
        const context: AgentRuntimeContext = { plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
            contribution: { id: 'deepsec', qualifiedId: `${PLUGIN_MANIFEST.id}/agents/deepsec` },
            surface: 'agent', signal, services, agent: { id: 'deepsec' }, protocols: { acp: { open: unused } },
            ui: { askQuestions: unused, confirm: unused, notify: unused, status: { set: unused }, widget: { set: unused },
                title: { set: unused }, composer: { replace: unused } } };
        const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
        try {
            const factory = plugin.registration('agents', 'deepsec')?.factory;
            if (!factory) throw new Error('DeepSec registration missing');
            const agent = await factory({ plugin: context.plugin, agent: context.agent, signal });
            const path = { path: 'src/auth.ts', previousPath: null, kind: 'modified', hasCommittedDelta: false,
                hasUncommittedDelta: true, diff: { committedAvailable: false, uncommittedAvailable: true, isBinary: false } };
            const request: AgentExecutionRunOpenRequest = { kind: 'create', runId: 'deepsec-selection', cwd: home.directory,
                profile: { pluginId: PLUGIN_MANIFEST.id, localId: 'review' },
                runnerAgentTarget: { kind: 'agent', identity: consumer },
                runnerConnectedAccountPurposes: prepared.purposes, runnerConnectedAccountMaterialization: prepared.materialization,
                launchEnvironment: prepared.launchEnvironment,
                ...(modelSelection ? { modelSelection } : {}),
                input: { text: 'Review authentication', structuredInput: {
                    reviewers: [{ kind: 'engine', engineId: 'deepsec' }], instructions: 'Review authentication',
                    engines: { deepsec: { mode: 'current_diff', confirmedCostWarning: true } },
                    scmReviewScope: { kind: 'review_scm_scope.v1', status: 'supported', scmBackendId: 'git', scmMode: '.git',
                        repositoryRoot: home.directory, worktreeRoot: home.directory, baseRef: { source: 'unavailable', ref: null },
                        selectedPaths: ['src/auth.ts'], changedPaths: [path], committedPaths: [], uncommittedPaths: [path],
                        diff: { committedAvailable: false, uncommittedAvailable: true }, diagnostics: [] },
                } } };
            const runtime = await agent.executionRuns?.open(request, context);
            if (!runtime) throw new Error('DeepSec runtime missing');
            const events: AgentExecutionRunEvent[] = [];
            try {
                await new Promise<void>(resolve => runtime.watch(event => {
                    events.push(event);
                    if (event.kind === 'run-complete' || event.kind === 'run-failed' || event.kind === 'run-cancelled') resolve();
                }));
                expect(events.at(-1)).toMatchObject({ kind: 'run-complete' });
                return { process: nativeRequests.find(request => request.args?.[0] === 'process'), events };
            } finally { await runtime.dispose(); }
        } finally { await plugin.dispose(); await resolved?.cleanup(); }
    }

    it('uses an explicit Account over a conflicting linked Account, native login and ambient API keys', async () => {
        const { process, events } = await launch(connected('explicit-account'));
        expect(transport.materialize).toHaveBeenCalledWith(expect.objectContaining({ connectedServices: connected('explicit-account') }), expect.anything());
        expect(homeReads).toEqual([]);
        expect(process?.env).toMatchObject({ CODEX_HOME: '/selected/explicit-account', OPENAI_API_KEY: '', AI_GATEWAY_API_KEY: '' });
        expect(JSON.stringify(events)).not.toMatch(/ambient-key|ambient-gateway/);
    });
    it('uses the linked Account when no explicit source is selected despite an existing native login', async () => {
        const { process } = await launch();
        expect(homeReads).toContain(`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`);
        const bindings = ConnectedServiceBindingsV2Schema.parse(transport.materialize.mock.calls[0]?.[0].connectedServices).bindingsByServiceId;
        expect(bindings[serviceId]).toEqual(connected('linked-account').bindingsByServiceId[serviceId]);
        expect(Object.entries(bindings).filter(([id]) => id !== serviceId).map(([, binding]) => binding))
            .toEqual(expect.arrayContaining([{ source: 'native' }]));
        expect(Object.entries(bindings).filter(([id]) => id !== serviceId).every(([, binding]) => binding.source === 'native')).toBe(true);
        expect(process?.env).toMatchObject({ CODEX_HOME: '/selected/linked-account', OPENAI_API_KEY: '', AI_GATEWAY_API_KEY: '' });
    });
    it('refuses an unreadable selected Account instead of falling back to native or ambient credentials', async () => {
        const failureCause = { code: 'credential_unavailable', phase: 'authentication', failureReason: 'authentication_required', retryable: false };
        transport.materialize.mockResolvedValue({ ok: false, errorCode: 'connected_service_run_materialization_blocked',
            error: 'Selected Account credential unavailable', failureCause });
        await expect(launch(connected('unreadable-account'))).rejects.toMatchObject({
            code: 'execution_run_connected_services_failed', executionRunErrorCode: 'credential_unavailable', details: { failureCause },
        });
        expect(transport.materialize).toHaveBeenCalledTimes(1);
        expect(nativeRequests).toEqual([]);
        expect(homeReads).toEqual([]);
    });
    it('consumes the deliberate UI native choice rather than Agent default without a linked Account or API key', async () => {
        linkedAccount = null;
        const nativeModel = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5' };
        const draft = { sessionId: 'fixture-session', instructions: 'Review authentication',
            reviewers: [{ kind: 'engine', engineId: 'deepsec', runnerAgentTarget: { kind: 'agent', identity: consumer } }] };
        const chosen = applyExecutionRunChildSelection(draft, nativeModel);
        const admitted = ReviewStartInputSchema.parse(chosen);
        const engine = admitted.reviewers.find(reviewer => reviewer.kind === 'engine');
        if (!engine || engine.kind !== 'engine') throw new Error('Selected DeepSec reviewer missing');
        expect(engine.modelSelection).toEqual(nativeModel);
        expect(engine.connectedServices).toBeNull();
        const defaulted = ReviewStartInputSchema.parse(applyExecutionRunChildSelection(chosen, 'agentDefault'));
        expect(defaulted.reviewers[0]).toMatchObject({ childSelection: 'agentDefault' });
        expect(defaulted.reviewers[0]).not.toHaveProperty('connectedServices');
        expect(defaulted.reviewers[0]).not.toHaveProperty('modelSelection');
        const selectedServices = ExecutionRunStartRequestBaseSchema.shape.connectedServices.parse(engine.connectedServices);
        const { process } = await launch(selectedServices, nativeModel);
        expect(homeReads).toEqual([]);
        expect(transport.materialize).not.toHaveBeenCalled();
        expect(process?.args).toEqual(expect.arrayContaining(['--agent', 'codex', '--ai-api-key-env', 'OPENAI_API_KEY', '--model', 'gpt-5']));
        expect(process?.env).toMatchObject({ CODEX_HOME: '/machine/native-login', OPENAI_API_KEY: '', AI_GATEWAY_API_KEY: '' });
    });
});
