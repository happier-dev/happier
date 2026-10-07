import * as React from 'react';
import { Dimensions } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIBackendProfileSchema, buildBackendTargetKeyV2, parseBackendTargetKeyV2, DaemonContributionRegistryProjectionDescribeResponseSchema, ExecutionRunPublicStateSchema, FeaturesResponseSchema, MACHINE_PLAIN_DATA_KEY_MARKER, PersistedBackendTargetRefV2Schema, V2SessionByIdResponseSchema } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { changeTextTestInstance, createMachineFixture, createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveActionHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { AgentInput } from '@/components/sessions/agentInput';
import { SessionParticipantComposer } from '@/components/sessions/participants/composer/SessionParticipantComposer';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { ensureSessionDraftRepositoryHydrated, getSessionDraftSnapshot, resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { invalidateRoleCatalog } from '@/components/roles/catalog/useRoleCatalog';
import { t } from '@/text';
import { SessionInteractiveExecutionRunDraftView } from './SessionInteractiveExecutionRunDraftView';
import { StartReviewDialog } from '@/components/sessions/reviews/walkthrough/StartReviewDialog';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { restoreConnectionToActiveServer, disconnectActiveServerConnection } from '@/sync/runtime/orchestration/connectionManager';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';

// Platform, credentials, local persistence, HTTP and RPC are the boundaries. The composer,
// capture/coordinator, draft repository, launcher options, role catalog, capability/feature
// decisions, default Action executor and sync.submitMessage all run for real.
// The common AgentInput installer deliberately supplies a small fake store. This journey needs
// the whole real store, so install its canonical platform factories without that store override.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: modal.alert, show: modal.show } }).module;
});
vi.mock('expo-image', () => ({ Image: (props: Record<string, unknown>) => React.createElement('Image', props) }));
vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});
type RpcRequest = Readonly<{ sessionId?: string; machineId?: string; serverId?: string | null; scope?: { serverId: string }; method: string; payload: unknown }>;
const transport = vi.hoisted(() => ({ call: vi.fn<(request: RpcRequest) => Promise<unknown>>() }));
vi.mock('socket.io-client', async () => {
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    return { io: (url: string) => {
        const { socket } = createSocketIoBoundaryStub();
        socket.emitWithAck.mockImplementation(async (event, raw) => {
            if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: ['session_1'] };
            if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) {
                throw new Error('Malformed Socket RPC boundary request');
            }
            const colon = raw.method.indexOf(':');
            const target = raw.method.slice(0, colon);
            const method = raw.method.slice(colon + 1);
            const { listServerProfiles } = await import('@/sync/domains/server/serverProfiles');
            const serverId = listServerProfiles().find((profile) => profile.serverUrl === url)?.id;
            return { ok: true, result: await transport.call({ method, payload: raw.params, serverId,
                ...(target === 'machine_1' ? { machineId: target } : { sessionId: target }) }) };
        });
        return socket;
    } };
});
const modal = vi.hoisted(() => ({ alert: vi.fn(), show: vi.fn() }));
const platform = vi.hoisted(() => ({ focus: vi.fn() }));
const random = vi.hoisted(() => ({ next: 0 }));
vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => `identity_${++random.next}` }));

await loadSyncSingletonForTests();

type Screen = Awaited<ReturnType<typeof renderScreen>>;
type ComposerProps = React.ComponentProps<typeof SessionParticipantComposer>;
type Chip = NonNullable<ComposerProps['extraActionChips']>[number];
type Run = Readonly<Record<string, unknown>>;
let home: Awaited<ReturnType<typeof serveActionHomes>>;
let serverId = '';
let sequence = 0;
let screen: Screen;
let backends: Record<string, { available: boolean; intents: string[] }>;
let protocolSupported = true;
let admissionFailure = false;
let admissionGate: Promise<void> | null = null;
let startResults: Array<unknown | Promise<unknown>>;
let listedRuns: Run[];
let listResult: Promise<unknown> | null;
let emittedStarts: Array<Record<string, unknown>>;
let outbound: ServedHomeRequest[];
let pluginProjection = false;

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected boundary object');
    return value as Record<string, unknown>;
}
function started(runId = 'run_1') { return { runId, callId: `call_${runId}`, sidechainId: `side_${runId}` }; }
function uncertain() { return { ok: false, error: 'response lost', details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } } }; }
function noRun() { return { ok: false, error: 'not started', details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } }; }
function run(runId: string, launchOrigin?: unknown): Run {
    return ExecutionRunPublicStateSchema.parse({ ...started(runId), intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only', status: 'running', startedAtMs: 1,
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', ...(launchOrigin ? { launchOrigin } : {}) });
}
function startedTargetKey(value: Record<string, unknown>) { return buildBackendTargetKeyV2(PersistedBackendTargetRefV2Schema.parse(value.backendTarget)); }
function canonicalTargetKey(optionId: string) { return buildBackendTargetKeyV2(parseBackendTargetKeyV2(optionId)); }
function setSettings(patch: Partial<Settings>) {
    getStorage().setState((state) => ({ settings: { ...state.settings, ...patch } }));
}
function composer(): ComposerProps { return screen.root.findByType(Reflect.get(SessionParticipantComposer, 'type')).props as ComposerProps; }
function chip(key: string): Chip {
    const found = composer().extraActionChips?.find((item) => item.key === key);
    expect(found, key).toBeDefined();
    return found!;
}
function input() {
    const found = screen.root.findAll((node) => node.props.testID === 'session-composer-input' && typeof node.props.onChangeText === 'function').at(-1);
    expect(found).toBeDefined();
    return found!;
}
function sendButton() {
    const found = screen.root.findAll((node) => node.props.testID === 'session-composer-send' && typeof node.props.onPress === 'function').at(-1);
    expect(found).toBeDefined();
    return found!;
}
async function settle() {
    await act(async () => {});
}
async function waitFor(assertion: () => void) {
    await vi.waitFor(async () => { await settle(); assertion(); });
}
async function mount(props: Partial<React.ComponentProps<typeof SessionInteractiveExecutionRunDraftView>> = {}) {
    screen = await renderScreen(<SessionInteractiveExecutionRunDraftView sessionId="session_1" serverId={serverId} onRunStarted={vi.fn()} {...props} />, {
        createNodeMock: (element) => element.type === 'TextInput'
            ? { focus: platform.focus, blur: vi.fn(), setNativeProps: vi.fn() }
            : null,
    });
    await settle();
    return screen;
}
async function type(text: string) { await act(async () => changeTextTestInstance(input(), text)); }
async function send(text = 'Inspect this', waitForCompletion = true) {
    await type(text);
    await waitFor(() => expect(composer().canSendMessages, JSON.stringify({ visible: screen.getTextContent(), rpc: transport.call.mock.calls.map(([request]) => request.method), http: home.requests.map((request) => request.path) })).toBe(true));
    await act(async () => { await sendButton().props.onPress(); });
    await settle();
    if (waitForCompletion) await waitFor(() => expect(screen.findByTestId('execution-run-conversation-phase')).toBeNull());
}
async function selectEngine(id: string) { await act(async () => composer().engine?.onSelect(id)); }
async function renderChipContent(key: string) {
    const renderContent = chip(key).collapsedContentPopover?.renderContent;
    return renderScreen(<>{typeof renderContent === 'function' ? renderContent({ requestClose: vi.fn(), maxHeight: Dimensions.get('window').height }) : renderContent}</>);
}
async function renderChip(key: string) {
    return renderScreen(<>{chip(key).render({ chipStyle: () => ({}), showLabel: true, iconColor: '#000', textStyle: {}, countTextStyle: {}, popoverAnchorRef: React.createRef() })}</>);
}
async function reviewers() {
    const choices = await renderChipContent('execution-run-start-reviewers-add');
    // The current catalog includes every enabled bundled Agent. This journey chooses
    // two reviewers; it must not silently select every unrelated catalog entry.
    const prefix = 'execution-run-launcher-target:';
    const available = [...new Set(choices.root.findAll(node => typeof node.props.testID === 'string'
        && node.props.testID.startsWith(prefix)).map(node => String(node.props.testID)))];
    const ids = ['claude', 'codex'].map(agentId => {
        const id = available.find(candidate => canonicalTargetKey(candidate.slice(prefix.length)) === canonicalTargetKey('agent:' + agentId));
        if (!id) throw new Error('Expected selectable reviewer: ' + agentId);
        return id;
    });
    for (const id of ids) await choices.pressByTestIdAsync(id);
    await settle();
    return ids;
}
function reviewerKeys() { return (composer().extraActionChips ?? []).map((item) => item.key).filter((key) => key.startsWith('execution-run-start-reviewer:')); }
function draft(runId = 'run_1') { return getSessionDraftSnapshot({ serverId, accountId: 'account_1' }, { kind: 'run', sessionId: 'session_1', runId }); }
function admitted() { return record(outbound.at(-1)?.body); }
function admittedRunId() { return outbound.at(-1)?.path.split('/execution-runs/')[1]?.split('/')[0]; }
function outboundText() {
    const content = record(admitted().content);
    return JSON.stringify(content);
}

describe('SessionInteractiveExecutionRunDraftView — real composer and Action path', () => {
    beforeEach(async () => {
        random.next = 0;
        protocolSupported = true;
        admissionFailure = false;
        admissionGate = null;
        pluginProjection = false;
        backends = { claude: { available: true, intents: ['delegate', 'review', 'plan'] }, codex: { available: true, intents: ['delegate', 'review', 'plan'] } };
        startResults = [];
        listedRuns = [];
        listResult = null;
        emittedStarts = [];
        outbound = [];
        modal.alert.mockClear();
        modal.show.mockClear();
        platform.focus.mockClear();
        resetSessionDraftRepositoryForTests();
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
        clearDaemonMergedProjectionCacheForTests();
        transport.call.mockReset();
        transport.call.mockImplementation(async (request) => {
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return {
                protocolVersion: 1,
                results: { 'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: {
                    available: true, backends, protocolVersion: 2,
                    features: { detachedScope: true, startAndWait: true, exactInputResults: true, runScopedAgentBindings: protocolSupported, secretReferenceOverlay: protocolSupported },
                } } },
            };
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_START) {
                emittedStarts.push(record(request.payload));
                return await (startResults.shift() ?? started());
            }
            if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
                // A successful, ready daemon resume publishes the host's active Session fact.
                getStorage().setState((state) => ({ sessions: { session_1: { ...state.sessions.session_1!, active: true } } }));
                return { type: 'success', sessionId: 'session_1' };
            }
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return await (listResult ?? { runs: listedRuns });
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE && pluginProjection) return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
                protocolVersion: 1,
                projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
            });
            return { errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' };
        });
        home = await serveActionHomes({
            homes: [{ key: 'home', serverUrl: `https://launcher-${++sequence}.example.test`, accountId: 'account_1' }],
            route: async (request) => {
                if (request.path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({
                    features: { execution: { runs: { enabled: true } }, encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } } },
                    capabilities: { session: { pendingInput: { protocolVersion: 3 } }, accountStoredContentCompatibility: { v: 1, currentProtocolVersion: 3, minimumProtocolVersion: 3, declarationTransport: 'http-header-and-socket-auth-v1' } },
                }));
                if (request.path === '/v1/machines/machine_1') return Response.json({ machine: { id: 'machine_1', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } });
                if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (request.path === '/v2/sessions/session_1') {
                    const session = getStorage().getState().sessions.session_1!;
                    return Response.json(V2SessionByIdResponseSchema.parse({ session: { ...session, metadata: JSON.stringify(session.metadata), dataEncryptionKey: null } }));
                }
                if (request.path.includes('/execution-runs/') && request.path.endsWith('/pending')) {
                    if (request.method === 'GET') return Response.json({ pending: [], discarded: [], pendingVersion: 1, pendingCount: 0 });
                    outbound.push(request);
                    await admissionGate;
                    if (admissionFailure) return Response.json({ error: 'execution_run_not_allowed' }, { status: 409 });
                    const body = record(request.body);
                    const recipient = { kind: 'execution_run', runId: request.path.split('/execution-runs/')[1]!.split('/')[0] };
                    return Response.json({ didWrite: true, recipient, requestedAction: body.requestedAction,
                        pending: { ...body, recipient, status: 'queued', position: 1, createdAt: 1, updatedAt: 1 }, pendingVersion: 1, pendingCount: 1 });
                }
                if (request.path === '/v1/artifacts') return Response.json([]);
                return Response.json({ error: 'not_found' }, { status: 404 });
            },
        });
        serverId = home.homes.home!.id;
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.homes.home!.serverUrl);
        if (!credentials) throw new Error('Fixture credentials unavailable');
        await restoreConnectionToActiveServer(credentials);
        const session = createSessionFixture({ id: 'session_1', serverId, active: true, pendingVersion: 3,
            metadata: { path: '/repo', host: 'tester.local', homeDir: '/Users/tester', machineId: 'machine_1', flavor: 'claude' } });
        const machine = createMachineFixture({ id: 'machine_1', activeAt: Date.now(), storageMode: 'plain' });
        getStorage().setState({ sessions: { session_1: session }, machines: { machine_1: machine }, machineListByServerId: { [serverId]: [machine] },
            settings: { ...settingsDefaults, experiments: true, featureToggles: { 'execution.runs': true }, backendEnabledByTargetKey: {}, sessionMessageSendMode: 'server_pending', currentSecretBindingsByProfileId: {} },
            settingsScope: { serverId, accountId: 'account_1' }, profileScope: { serverId, accountId: 'account_1' } });
        await ensureSessionDraftRepositoryHydrated({ serverId, accountId: 'account_1' });
    });
    afterEach(async () => { await disconnectActiveServerConnection(); await standardCleanup(); home?.dispose(); });

    it('creates nothing until rendered Send, then admits captured text to the exact new Run', async () => {
        const opened = vi.fn();
        await mount({ onRunStarted: opened });
        const inputId = composer().initialLocalId;
        expect(emittedStarts).toEqual([]);
        expect(outbound).toEqual([]);
        await send();
        expect(emittedStarts[0]).toMatchObject({ intent: 'delegate', runClass: 'long_lived', launchOrigin: { kind: 'session', sessionId: 'session_1', draftCorrelationId: expect.any(String) } });
        await waitFor(() => expect(opened).toHaveBeenCalledWith('run_1', undefined, { title: 'Inspect this' }));
        expect(outbound[0]).toMatchObject({ home: 'home', accountId: 'account_1', path: '/v2/sessions/session_1/execution-runs/run_1/pending' });
        expect(admitted()).toMatchObject({ localId: inputId, targetMachineId: 'machine_1' });
        expect(outboundText()).toContain('Inspect this');
    });
    it('clears the accepted Run draft before navigation retires the Account binding', async () => {
        let atNavigation: unknown;
        await mount({ onRunStarted: () => { atNavigation = draft()?.document.composer.text.value; retireActiveServerAccountScopeLifetime(); } });
        await send();
        await waitFor(() => expect(atNavigation).toBe(''));
        expect(input().props.value).toBe('');
    });
    it('preserves text authored after capture when admission hands off before navigation retires the binding', async () => {
        let acknowledge!: () => void;
        admissionGate = new Promise((resolve) => { acknowledge = resolve; });
        let atNavigation: unknown;
        await mount({ onRunStarted: () => { atNavigation = draft()?.document.composer.text.value; retireActiveServerAccountScopeLifetime(); } });
        await send('Inspect this', false);
        await waitFor(() => expect(outbound).toHaveLength(1));
        await type('Typed after capture');
        expect(outboundText()).toContain('Inspect this');
        expect(outboundText()).not.toContain('Typed after capture');
        await act(async () => acknowledge());
        await waitFor(() => expect(atNavigation).toBe('Typed after capture'));
        expect(input().props.value).toBe('Typed after capture');
    });
    it('starts with the eligible Agent selected in the real launcher options', async () => {
        await mount();
        const codex = composer().engine!.options.find((option) => option.id.includes('codex'))!;
        await selectEngine(codex.id);
        await send();
        expect(startedTargetKey(emittedStarts[0]!)).toBe(canonicalTargetKey(codex.id));
        expect(admittedRunId()).toBe('run_1');
    });
    it('does not let an unavailable default Agent hide an eligible Agent', async () => {
        backends.claude = { available: false, intents: ['delegate'] };
        await mount();
        expect(composer().engine!.options.some((option) => option.id.includes('codex'))).toBe(true);
        const codex = composer().engine!.options.find((option) => option.id.includes('codex'))!;
        await send();
        expect(startedTargetKey(emittedStarts[0]!)).toBe(canonicalTargetKey(codex.id));
    });
    it('starts an eligible installed-plugin Agent even when the default Agent is unavailable', async () => {
        pluginProjection = true;
        backends = { claude: { available: false, intents: ['delegate'] }, 'acme.review.provider': { available: true, intents: ['delegate'] } };
        await mount();
        await send();
        expect(emittedStarts[0]).toMatchObject({ backendTarget: { kind: 'agent', identity: { pluginId: 'acme.review', localId: 'provider' } } });
    });
    it('rejoins exactly one correlated Run after an uncertain start without starting another', async () => {
        startResults.push(uncertain());
        await mount();
        const baseTransport = transport.call.getMockImplementation()!;
        transport.call.mockImplementation(async (request) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST
            ? { runs: [run('run_found', emittedStarts[0]?.launchOrigin)] }
            : baseTransport(request));
        await send();
        expect(emittedStarts).toHaveLength(1);
        await waitFor(() => expect(admittedRunId()).toBe('run_found'));
    });
    it('does not guess when correlation has zero matches and leaves authored text intact', async () => {
        startResults.push(uncertain());
        await mount();
        const inputId = composer().initialLocalId;
        await send();
        expect(emittedStarts).toHaveLength(1);
        expect(outbound).toEqual([]);
        expect(input().props.value).toBe('Inspect this');
        expect(composer().initialLocalId).toBe(inputId);
        expect(composer().canSendMessages).toBe(false);
        expect(screen.findByTestId('execution-run-conversation-error')?.props.children)
            .toBe(t('sessionDrafts.executionRunStart.unresolved'));
        expect(screen.findByTestId('execution-run-conversation-start-another')).not.toBeNull();
        expect(transport.call.mock.calls.filter(([request]) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST))
            .toEqual([[expect.objectContaining({ sessionId: 'session_1', serverId, payload: {} })]]);
    });
    it('offers no second Start while reconciliation is pending', async () => {
        startResults.push(uncertain());
        let resolveList!: (result: unknown) => void;
        listResult = new Promise((resolve) => { resolveList = resolve; });
        await mount();
        await send('Inspect this', false);
        expect(composer().canSendMessages).toBe(false);
        const inputId = composer().initialLocalId;
        expect(screen.findByTestId('execution-run-conversation-start-another')).toBeNull();
        expect(emittedStarts).toHaveLength(1);
        await act(async () => resolveList({ runs: [] }));
        await settle();
        await waitFor(() => expect(screen.findByTestId('execution-run-conversation-start-another')).not.toBeNull());
        expect(composer().canSendMessages).toBe(false);
        expect(composer().initialLocalId).toBe(inputId);
        expect(input().props.value).toBe('Inspect this');
        expect(emittedStarts).toHaveLength(1);
        expect(outbound).toEqual([]);
    });
    it('uses fresh correlation and input identities only after explicit Start another', async () => {
        startResults.push(uncertain(), started('run_new'));
        await mount();
        const initialInputId = composer().initialLocalId;
        await send();
        expect(composer().initialLocalId).toBe(initialInputId);
        expect(input().props.value).toBe('Inspect this');
        expect(emittedStarts).toHaveLength(1);
        await screen.pressByTestIdAsync('execution-run-conversation-start-another');
        await settle();
        expect(composer().initialLocalId).not.toBe(initialInputId);
        expect(input().props.value).toBe('Inspect this');
        expect(emittedStarts).toHaveLength(1);
        expect(outbound).toEqual([]);
        await send();
        expect(record(emittedStarts[0]?.launchOrigin).draftCorrelationId).not.toBe(record(emittedStarts[1]?.launchOrigin).draftCorrelationId);
        expect(admitted().localId).not.toBe(initialInputId);
    });
    it('preserves selected Agent and correlation across a known no-run retry', async () => {
        startResults.push(noRun(), started());
        await mount();
        await selectEngine(composer().engine!.options.find((option) => option.id.includes('codex'))!.id);
        await send();
        await send();
        const selected = canonicalTargetKey(composer().engine!.selectedOptionId!);
        expect(emittedStarts.map(startedTargetKey)).toEqual([selected, selected]);
        expect(emittedStarts[0]?.launchOrigin).toEqual(emittedStarts[1]?.launchOrigin);
    });
    it('does not guess when correlation has multiple matches', async () => {
        startResults.push(uncertain());
        await mount();
        const baseTransport = transport.call.getMockImplementation()!;
        transport.call.mockImplementation(async (request) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST
            ? { runs: [run('run_a', emittedStarts[0]?.launchOrigin), run('run_b', emittedStarts[0]?.launchOrigin)] }
            : baseTransport(request));
        await send();
        expect(emittedStarts).toHaveLength(1);
        expect(outbound).toEqual([]);
        expect(input().props.value).toBe('Inspect this');
        expect(composer().canSendMessages).toBe(false);
        expect(screen.findByTestId('execution-run-conversation-error')?.props.children)
            .toBe(t('sessionDrafts.executionRunStart.unresolved'));
    });
    it('retains the materialized Run and exact draft when HTTP admission refuses custody', async () => {
        admissionFailure = true;
        const opened = vi.fn();
        await mount({ onRunStarted: opened });
        const inputId = composer().initialLocalId;
        await send();
        await waitFor(() => expect(opened).toHaveBeenCalledWith('run_1', { retryInputLocalId: inputId }, { title: 'Inspect this' }));
        expect(draft()?.document.composer.text.value).toBe('Inspect this');
    });
    it('does not start from an ambient same-id Session in another Home', async () => {
        getStorage().setState((state) => ({ sessions: { session_1: { ...state.sessions.session_1!, serverId: 'wrong_home' } } }));
        await mount();
        await type('Keep my draft');
        expect(composer().canSendMessages).toBe(false);
        expect(input().props.value).toBe('Keep my draft');
        expect(emittedStarts).toEqual([]);
    });
    it('keeps the actual mounted composer and unsent content across Start another', async () => {
        startResults.push(uncertain());
        await mount();
        const owner = screen.root.findByType(Reflect.get(AgentInput, 'type'));
        await send();
        await screen.pressByTestIdAsync('execution-run-conversation-start-another');
        await settle();
        expect(screen.root.findByType(Reflect.get(AgentInput, 'type'))).toBe(owner);
        expect(input().props.value).toBe('Inspect this');
    });
    it('announces launch and reconciliation through the polite status owner', async () => {
        let resolveStart!: (result: unknown) => void;
        let resolveList!: (result: unknown) => void;
        startResults.push(new Promise((resolve) => { resolveStart = resolve; }));
        listResult = new Promise(resolve => { resolveList = resolve; });
        await mount();
        await send('Inspect this', false);
        expect(screen.findHostByTestId('execution-run-conversation-accessibility-status')?.props.accessibilityLiveRegion).toBe('polite');
        await act(async () => resolveStart(uncertain()));
        await waitFor(() => expect(screen.findByTestId('execution-run-conversation-phase')).not.toBeNull());
        expect(screen.getTextContent()).toContain(t('sessionDrafts.executionRunStart.reconciling'));
        await act(async () => resolveList({ runs: [] }));
        await waitFor(() => expect(screen.findByTestId('execution-run-conversation-start-another')).not.toBeNull());
    });
    it('registers the actual composer focus target only when autofocus is requested', async () => {
        await mount({ autoFocusComposer: true });
        await waitFor(() => expect(platform.focus).toHaveBeenCalled());
        await screen.unmount();
        platform.focus.mockClear();
        await mount({ autoFocusComposer: false });
        expect(platform.focus).not.toHaveBeenCalled();
    });
    it('keeps Ask Agent selection as context and sends it ahead of the typed question', async () => {
        await mount({ initialText: 'Selected discussion messages', launchOrigin: { kind: 'session_discussion', sessionId: 'session_1', discussionId: 'discussion_1', messageIds: ['message_1'], draftCorrelationId: 'selection_1' } });
        expect(input().props.value).toBe('');
        await send('Why did this fail?');
        expect(outboundText()).toContain('Selected discussion messages');
        expect(outboundText()).toContain('Why did this fail?');
        expect(emittedStarts[0]).toMatchObject({ launchOrigin: { discussionId: 'discussion_1', draftCorrelationId: 'selection_1' } });
    });
    it('titles the new Run by the captured question', async () => {
        const opened = vi.fn();
        await mount({ onRunStarted: opened });
        await send('Explain this race');
        await waitFor(() => expect(opened).toHaveBeenCalledWith('run_1', undefined, { title: 'Explain this race' }));
        expect(emittedStarts[0]).toMatchObject({ display: { title: 'Explain this race' } });
    });
    it('keeps Discussion provenance after explicit unresolved recovery', async () => {
        startResults.push(uncertain(), started());
        await mount({ initialText: 'Selection', launchOrigin: { kind: 'session_discussion', sessionId: 'session_1', discussionId: 'discussion_1', messageIds: ['message_1'], draftCorrelationId: 'selection_1' } });
        await send();
        await screen.pressByTestIdAsync('execution-run-conversation-start-another');
        await settle();
        await send();
        expect(emittedStarts[1]).toMatchObject({ launchOrigin: { kind: 'session_discussion', discussionId: 'discussion_1', messageIds: ['message_1'] } });
        expect(record(emittedStarts[1]?.launchOrigin).draftCorrelationId).not.toBe('selection_1');
    });
    it('forwards the Report chip selection on a plain conversation', async () => {
        await mount();
        expect(chip('execution-run-start-report').stabilityKey).toMatch(/^false:/);
        const report = await renderChip('execution-run-start-report');
        const toggle = report.root.findAll((node) => node.props.testID === 'execution-run-start-report-switch' && typeof node.props.onValueChange === 'function').at(-1)!;
        await act(async () => toggle.props.onValueChange(true));
        await send();
        expect(emittedStarts[0]).toMatchObject({ notifyParentOnCompletion: true });
    });
    it('starts all selected reviewers through real review.start and accepts the typed instructions', async () => {
        const opened = vi.fn();
        startResults.push(started('run_claude'), started('run_codex'));
        await mount({ intent: 'review', onRunStarted: opened });
        expect(composer().canSendMessages).toBe(false);
        expect(await reviewers()).toHaveLength(2);
        expect(reviewerKeys()).toHaveLength(2);
        await send();
        expect(emittedStarts).toHaveLength(2);
        expect(emittedStarts.map((value) => value.intent)).toEqual(['review', 'review']);
        for (const start of emittedStarts) expect(start).toMatchObject({ instructions: 'Inspect this', notifyParentOnCompletion: true, retentionPolicy: 'resumable' });
        expect(record(emittedStarts[0]?.display).groupId).toBe(record(emittedStarts[1]?.display).groupId);
        expect(input().props.value).toBe('');
        await waitFor(() => expect(opened).toHaveBeenCalledWith('run_claude', undefined, { title: 'Inspect this' }));
    });
    it('removes one chosen reviewer from its real removable chip', async () => {
        await mount({ intent: 'review' });
        await reviewers();
        const first = reviewerKeys()[0]!;
        const reviewer = await renderChip(first);
        await reviewer.pressByTestIdAsync(`${first}:remove`);
        await send();
        expect(emittedStarts).toHaveLength(1);
    });
    it('opens a partially started review and names the reviewer that failed', async () => {
        startResults.push(started('run_claude'), { ok: false, error: 'review_engine_unavailable', errorCode: 'review_engine_unavailable' });
        const opened = vi.fn();
        await mount({ intent: 'review', onRunStarted: opened });
        await reviewers();
        await send();
        await waitFor(() => expect(opened).toHaveBeenCalledWith('run_claude', undefined, { title: 'Inspect this' }));
        await waitFor(() => expect(modal.alert).toHaveBeenCalledWith(t('runPage.review.reviewersNotStarted', { count: 1 }), expect.any(String)));
        const failureMessage = modal.alert.mock.calls.at(-1)![1];
        expect(failureMessage).toContain('codex');
        expect(failureMessage).not.toContain('claude');
        expect(input().props.value).toBe('');
    });
    it('keeps the typed draft when the real plan Action refuses every start', async () => {
        startResults.push({ ok: false, error: 'backend_unavailable' });
        const opened = vi.fn();
        await mount({ intent: 'plan', onRunStarted: opened });
        await send();
        expect(emittedStarts[0]).toMatchObject({ intent: 'plan', instructions: 'Inspect this', notifyParentOnCompletion: true });
        expect(opened).not.toHaveBeenCalled();
        expect(input().props.value).toBe('Inspect this');
        expect(screen.findByTestId('execution-run-conversation-error')).not.toBeNull();
    });
    it('keeps a written draft while execution runs are disabled', async () => {
        setSettings({ featureToggles: { 'execution.runs': false } });
        await mount({ intent: 'review' });
        await type('Keep this');
        expect(composer().canSendMessages).toBe(false);
        expect(screen.findByTestId('execution-run-start-blocked')).not.toBeNull();
        expect(input().props.value).toBe('Keep this');
    });

    async function chooseRole(roleId: string) {
        const rail = composer().engine!.options[0]!;
        expect(rail.id).toBe('roles');
        const choices = await renderScreen(<>{rail.renderDetailContent?.({ onRequestClose: vi.fn() })}</>);
        // A real popover receives the composer's current controlled props when
        // the asynchronous catalog arrives. Keep this separately mounted leaf current too.
        await vi.waitFor(async () => {
            await choices.update(<>{composer().engine!.options[0]!.renderDetailContent?.({ onRequestClose: vi.fn() })}</>);
            expect(choices.findByTestId(`roles-rail-option:${roleId}`), JSON.stringify({ text: choices.getTextContent(), http: home.requests.map((request) => request.path) })).not.toBeNull();
        });
        await choices.pressByTestIdAsync(`roles-rail-option:${roleId}`);
        await settle();
    }
    it('chooses Planner from the real Roles rail and carries roleId through plan admission', async () => {
        await mount({ intent: 'plan' });
        await chooseRole('planner');
        await send();
        expect(emittedStarts[0]).toMatchObject({ intent: 'plan', roleId: 'planner' });
    });
    it('moves the selected Agent when the chosen role names another Agent', async () => {
        const roles = await createDefaultActionExecutor().execute('roles.list', {}, { serverId, expectedAccountId: 'account_1' });
        expect(roles, JSON.stringify(roles)).toMatchObject({ ok: true });
        await mount({ intent: 'delegate' });
        const codex = composer().engine!.options.find((option) => option.id.includes('codex'))!;
        setSettings({ rolesV1: { overrides: { scout: { roleId: 'scout', engine: { agentTargetKey: codex.id } } } } });
        invalidateRoleCatalog();
        await settle();
        await chooseRole('scout');
        expect(composer().engine!.selectedOptionId).toBe(codex.id);
    });
    it('names the implicit Reviewer role while leaving an unchosen roleId absent from the start', async () => {
        await mount({ intent: 'review' });
        const role = await renderChipContent('execution-run-start-role');
        expect(role.getTextContent()).toContain('Reviewer');
        await reviewers();
        await send();
        expect(emittedStarts[0]).not.toHaveProperty('roleId');
    });
    it('starts Second opinion through the real review Action with its explicit role', async () => {
        await mount({ intent: 'review', roleId: 'second_opinion' });
        await reviewers();
        await send();
        expect(emittedStarts[0]).toMatchObject({ intent: 'review', roleId: 'second_opinion' });
    });
    it('carries a chosen conversation role after the exact daemon confirms binding support', async () => {
        await mount();
        await chooseRole('scout');
        await send();
        expect(transport.call.mock.calls.some(([request]) => request.method === RPC_METHODS.CAPABILITIES_DETECT && request.machineId === 'machine_1' && request.serverId === serverId)).toBe(true);
        expect(emittedStarts[0]).toMatchObject({ roleId: 'scout' });
    });

    async function configureSecret() {
        const profile = AIBackendProfileSchema.parse({ id: 'work', name: 'Work', envVarRequirements: [{ name: 'ANTHROPIC_API_KEY', required: true, kind: 'secret' }] });
        setSettings({ profiles: [profile], secrets: [{ id: 'personal-secret', name: 'Personal secret', kind: 'token', encryptedValue: { _isSecretValue: true, value: 'sealed-secret' }, createdAt: 1, updatedAt: 1 }] });
        getStorage().setState((state) => ({ sessions: { session_1: { ...state.sessions.session_1!, metadata: { ...state.sessions.session_1!.metadata!, profileId: 'work' } } } }));
        await mount();
        await screen.pressByTestIdAsync('execution-run-secret-overlay-edit');
        const params = record(modal.show.mock.calls.at(-1)?.[0]);
        const onResolve = record(params.props).onResolve as (value: unknown) => void;
        await act(async () => onResolve({ action: 'selectSaved', envVarName: 'ANTHROPIC_API_KEY', secretId: 'personal-secret' }));
        await settle();
    }
    it('admits a comparison dialog review through the same Saved Secret target checks as the launcher', async () => {
        protocolSupported = false;
        const profile = AIBackendProfileSchema.parse({ id: 'work', name: 'Work', envVarRequirements: [{ name: 'ANTHROPIC_API_KEY', required: true, kind: 'secret' }] });
        setSettings({ profiles: [profile], secrets: [{ id: 'personal-secret', name: 'Personal secret', kind: 'token', encryptedValue: { _isSecretValue: true, value: 'sealed-secret' }, createdAt: 1, updatedAt: 1 }] });
        getStorage().setState((state) => ({ sessions: { session_1: { ...state.sessions.session_1!, metadata: { ...state.sessions.session_1!.metadata!, profileId: 'work' } } } }));
        screen = await renderScreen(<StartReviewDialog sessionId="session_1" serverId={serverId} cwd="/repo"
            comparison={{ kind: 'workingTree' }} comparisonId="captured-1" scopeLabel="Pending changes"
            defaultWalkthrough={false} onClose={vi.fn()} onStarted={vi.fn()} />);
        await settle();
        await screen.pressByTestIdAsync('execution-run-secret-overlay-edit');
        const onResolve = record(record(modal.show.mock.calls.at(-1)?.[0]).props).onResolve as (value: unknown) => void;
        await act(async () => onResolve({ action: 'selectSaved', envVarName: 'ANTHROPIC_API_KEY', secretId: 'personal-secret' }));
        await settle();
        await waitFor(() => expect(screen.findByTestId('start-review-start')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('start-review-start');
        await settle();
        expect(emittedStarts).toEqual([]);
        expect(screen.getTextContent()).toContain(t('sessionDrafts.executionRunStart.secretReferenceOverlayUpdateRequired'));
    });
    it('resumes the stopped host on its exact Home before the comparison dialog starts a review', async () => {
        getStorage().setState((state) => ({ sessions: { session_1: { ...state.sessions.session_1!, active: false,
            metadata: { ...state.sessions.session_1!.metadata!, claudeSessionId: 'native-session-1' } } } }));
        screen = await renderScreen(<StartReviewDialog sessionId="session_1" serverId={serverId} cwd="/repo"
            comparison={{ kind: 'workingTree' }} comparisonId="captured-1" scopeLabel="Pending changes"
            defaultWalkthrough={false} onClose={vi.fn()} onStarted={vi.fn()} />);
        await settle();
        await waitFor(() => expect(screen.findByTestId('start-review-start')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('start-review-start');
        await waitFor(() => expect(emittedStarts, JSON.stringify({ text: screen.getTextContent(), rpc: transport.call.mock.calls.map(([request]) => request), http: home.requests.map((request) => request.path) })).toHaveLength(1));
        const resume = transport.call.mock.calls.findIndex(([request]) => request.method === RPC_METHODS.SPAWN_HAPPY_SESSION || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);
        const review = transport.call.mock.calls.findIndex(([request]) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_START);
        expect(resume).toBeGreaterThanOrEqual(0);
        expect(resume).toBeLessThan(review);
        expect(transport.call.mock.calls[resume]?.[0]).toMatchObject({ machineId: 'machine_1', serverId,
            payload: { sessionId: 'session_1', spawnNonce: expect.stringMatching(/^execution-run-host-/) } });
        expect(emittedStarts[0]).toMatchObject({ intent: 'review', intentInput: { comparisonId: 'captured-1' } });
    });
    it('preflights a selected Saved Secret and creates no Run when the daemon lacks support', async () => {
        protocolSupported = false;
        await configureSecret();
        await send();
        expect(emittedStarts).toEqual([]);
        expect(screen.findByTestId('execution-run-conversation-error')?.props.children).toBe(t('sessionDrafts.executionRunStart.secretReferenceOverlayUpdateRequired'));
        expect(composer().canSendMessages).toBe(true);
        protocolSupported = true;
        await send();
        expect(emittedStarts).toHaveLength(1);
        expect(emittedStarts[0]).toMatchObject({ secretReferenceOverlay: { v: 1, bindings: { ANTHROPIC_API_KEY: { ref: 'personal-secret' } } } });
    });
    it('forwards a value-free Saved Secret overlay after exact-target acceptance', async () => {
        await configureSecret();
        await send();
        expect(emittedStarts[0]).toMatchObject({ secretReferenceOverlay: { v: 1, bindings: { ANTHROPIC_API_KEY: { ref: 'personal-secret' } } } });
        expect(JSON.stringify(emittedStarts)).not.toContain('sealed-secret');
    });
    it('does not create a Run when a Saved Secret selection becomes unavailable', async () => {
        await configureSecret();
        await act(async () => setSettings({ secrets: [] }));
        await settle();
        await type('Keep this secret-bound draft');
        expect(composer().canSendMessages).toBe(false);
        expect(emittedStarts).toEqual([]);
        expect(input().props.value).toBe('Keep this secret-bound draft');
    });
});
