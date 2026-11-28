import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { ToolCall } from "@happier-dev/session-core/messages";
import { buildSessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { listPendingRequestListsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { createSessionFixture, makeToolCall, makeToolViewProps } from '@/dev/testkit';
import {
    changeTextTestInstance,
    createDeferred,
    findTestInstanceByTypeContainingText,
    pressTestInstanceAsync,
    createTestSessionTranscriptSource,
    renderWithSessionTranscriptSource,
    standardCleanup,
} from '@/dev/testkit';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import {
    clearProjectedAgentUiBehaviorDescriptors,
} from '@/agents/registry/agentUiBehaviorProjection';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineFixture, createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { PluginProjectionV2Schema, DaemonContributionRegistryProjectionDescribeResponseSchema, DaemonPluginSettingsGetRequestSchema, DaemonPluginSettingsSetRequestSchema, DaemonPluginSettingsGetResponseSchema, DaemonPluginSettingsSetResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginAccountSettingsMutationRequestV1Schema, PluginAccountSettingsReadResponseV1Schema, PluginAccountSettingsMutationResponseV1Schema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionOutputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema, PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { HappyError } from '@/utils/errors/errors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { QuestionSendGroup } from './QuestionSendGroup';


Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sessionDeny = vi.fn();
const sendMessage = vi.fn();
const sessionAllowWithAnswers = vi.fn();
let questionRpcFailure: Readonly<{ name: 'PluginError'; code: string; message: string; retryable: boolean }> | null = null;
const readRequestOutcome = vi.fn<(requestId: string) => Promise<'pending' | 'settled'>>();
const pluginSettingsRecords = new Map<string, { revision: number; values: Record<string, unknown> }>();
const daemonSettingRequests: unknown[] = [];
const daemonProjectionRequests: unknown[] = [];
let daemonSettingValues: Record<string, unknown> = {};
let daemonSessionAttachSupported = true;
let supportsAnswersInPermission = true;
let activeAskUserQuestionRequest: { tool: string; kind?: 'user_action'; source?: string; turnId?: string } | null = null;
let activeAskUserQuestionRequestId = 'toolu_1';
const askUserQuestionSessionState = vi.hoisted(() => ({
    current: null as Record<string, unknown> | null,
}));
function readSessionFixture() {
    const session = createSessionFixture({
        id: 's1', serverId: account.serverId, active: true,
        metadata: {
            path: '/repo', host: 'tester.local',
            terminal: { mode: 'zellij', controlServiceabilityV1: { v: 1, attachmentId: 'question-attachment', state: 'servable', observedAt: 1 } },
            machineId: 'machine-1',
            runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
        },
        agentState: {
            capabilities: { askUserQuestionAnswersInPermission: supportsAnswersInPermission },
            requests: activeAskUserQuestionRequest
                ? { [activeAskUserQuestionRequestId]: {
                    ...activeAskUserQuestionRequest, arguments: {}, createdAt: 1,
                } } : {},
        },
        ...askUserQuestionSessionState.current,
    });
    const owner = readSessionOwnerMetadataView(session);
    if (owner && !owner.terminal) {
        const key = session.metadataLayoutVersion === 1 ? 'ownerMetadataView' : 'metadata';
        session[key] = { ...owner, path: owner.path || '/repo', terminal: { mode: 'zellij', controlServiceabilityV1: {
            v: 1, attachmentId: 'question-attachment', state: 'servable', observedAt: 1,
        } } };
    }
    return session;
}

async function renderScreen(element: React.ReactElement) {
    const props = element.props as Readonly<{ serverId?: string; session?: ReturnType<typeof createSessionFixture> }>;
    const read = () => props.session ?? readSessionFixture();
    await act(async () => {
        storage.setState({ sessions: { s1: readSessionFixture() } });
        const machine = storage.getState().machines['machine-1'];
        if (!machine?.metadata) throw new Error('Question machine fixture must carry admitted metadata');
        // The Account harness already hydrated this row through the real reader.
        // Retain its transport facts when varying the attached-terminal boundary.
        storage.getState().applyMachines([{ ...machine,
            metadata: { ...machine.metadata, daemonTerminalSessionAttachSupported: daemonSessionAttachSupported },
        }], true, { sourceServerId: account.serverId });
        const metadata = readSessionOwnerMetadataView(read());
        if (metadata?.machineId && read().serverId === account.serverId) {
            const projection = await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: metadata.machineId, serverId: read().serverId });
            expect(projection?.kind, JSON.stringify({
                reason: projection?.kind === 'error' ? projection.reason : null,
                requests: daemonProjectionRequests,
            })).toBe('ready');
        }
    });
    const source = createTestSessionTranscriptSource({
        sessionId: 's1', serverId: props.serverId ?? read().serverId ?? null,
        interaction: { canSendMessages: true, canApprovePermissions: true },
        actions: {
            answerUserAction: (params) => sessionAllowWithAnswers(params),
            respondToPermission: (params) => sessionDeny(params),
            abort: async () => {}, submitMessage: (params) => sendMessage(params),
            readRequestOutcome: (requestId) => readRequestOutcome(requestId),
        },
        navigate: () => {},
    });
    return renderWithSessionTranscriptSource(React.createElement(ModalProvider, {
        children: React.createElement(AppPaneProvider, { children: element }),
    }), {
        ...source,
        useAgentState: () => read().agentState,
        useArchivedAt: () => read().archivedAt ?? null,
        usePendingRequests: () => listPendingRequestListsFromSession(read(), []),
        useMetadata: () => readSessionOwnerMetadataView(read()),
    });
}
function createQuestionDaemonProjection() {
    const identities = {
        claude: { pluginId: 'happier.agent.claude', localId: 'claude' },
        'acme.review': { pluginId: 'acme.review', localId: 'review' },
    };
    const fields = {
        'happier.agent.claude': [
            { id: 'claudeUnifiedTerminalWorkspaceTrust', allowedValues: ['ask_every_time', 'always_trust_happier_workspaces', 'always_reject_happier_workspaces'] },
            { id: 'claudeUnifiedTerminalResumeChoice', allowedValues: ['ask_every_time', 'resume_from_summary', 'resume_full_session'] },
        ],
        'acme.review': [{ id: 'reviewScopePreference', allowedValues: ['ask_every_time', 'always_include'] }],
    };
    return PluginProjectionV2Schema.parse({
        v: 2, generation: 1,
        installedPackagesById: Object.fromEntries(Object.keys(fields).map(pluginId => [
            pluginId, { id: pluginId, displayName: pluginId, enabled: true, source: { kind: 'local', locator: '/plugins' } },
        ])),
        agentsById: Object.fromEntries(Object.entries(identities).map(([id, identity]) => [id, { id, identity }])),
        settingsById: Object.fromEntries(Object.values(identities).map(identity => [
            `${identity.pluginId}.settings`, {
                id: `${identity.pluginId}.settings`, pluginId: identity.pluginId, version: 1, title: 'Remembered choices',
                scope: { kind: 'account' }, presentation: { sections: [], subagentSections: [] },
                target: { kind: 'agent', agent: identity },
                fields: fields[identity.pluginId as keyof typeof fields].map(field => ({
                    id: field.id, kind: 'settings.field', version: '1.0.0', displayKey: field.id,
                    valueType: 'string', valueSchema: { type: 'string', enum: field.allowedValues }, control: 'select',
                    secretCustody: null, redaction: 'none',
                })),
            },
        ])),
    });
}
let daemonProjection = createQuestionDaemonProjection();

vi.mock('react-native', async () => {
    const { View } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    // RN Web observes empty-string View children before React's host renderer drops them.
    return (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ View });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key) => key }));
// The app owns errors and modal lifetime beneath Radix's DOM boundary.
vi.mock('@/utils/web/radixCjs', async () =>
    (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

// Load the real owner after boundary setup so cold module evaluation is outside a test and its act lifetime.
const account = createProviderSettingsAccountHarness();
const homes = account.home;
installDisconnectedServerSocketBoundary((socket) => {
    configureConnectedServerSocketBoundary(socket);
    socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, raw: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) {
            throw new Error('Malformed question daemon RPC');
        }
        const method = raw.method.slice(raw.method.indexOf(':') + 1);
        if (method === RPC_METHODS.SESSION_USER_ACTION_ANSWER && questionRpcFailure) {
            return { ok: true, result: questionRpcFailure };
        }
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            daemonProjectionRequests.push(raw.params);
            return { ok: true, result: DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: daemonProjection }) };
        }
        if (method === RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET) {
            const request = DaemonPluginSettingsGetRequestSchema.parse(raw.params);
            return { ok: true, result: DaemonPluginSettingsGetResponseSchema.parse({
                protocolVersion: 1, pluginId: request.pluginId, scope: request.scope,
                revision: 'revision-1', values: daemonSettingValues, redactedKeys: [],
            }) };
        }
        if (method === RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET) {
            const request = DaemonPluginSettingsSetRequestSchema.parse(raw.params);
            daemonSettingRequests.push(request);
            if (request.mutation.kind !== 'set') throw new Error('Expected a remembered setting value');
            daemonSettingValues = { ...daemonSettingValues, [request.fieldId]: request.mutation.value };
            return { ok: true, result: DaemonPluginSettingsSetResponseSchema.parse({
                status: 'applied', snapshot: {
                    protocolVersion: 1, pluginId: request.pluginId, scope: request.scope,
                    revision: 'revision-2', values: daemonSettingValues, redactedKeys: [],
                },
            }) };
        }
        return { ok: false, error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
    });
});
const { storage } = await import('@/sync/domains/state/storage');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { ModalProvider } = await import('@/modal/ModalProvider');
const { WebAlertModal } = await import('@/modal/components/WebAlertModal');
const { readSessionTerminalMode } = await import('@/components/sessions/terminal/sessionTerminalMode');
const { loadDaemonMergedProjectionCacheEntry, clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjection');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const initialStorageState = storage.getState();
const initialAppliedSnapshot = getAppliedActiveServerSnapshot();
const initialAppliedRuntimeAvailable = isAppliedActiveServerRuntimeAvailable();
const { AskUserQuestionView, projectAskUserQuestionDisplayText } = await import('./AskUserQuestionView');

describe('AskUserQuestionView', () => {
    type Screen = Awaited<ReturnType<typeof renderScreen>>;

    function expectNoAlert(screen: Screen) {
        expect(screen.findAllByType(WebAlertModal)).toHaveLength(0);
    }

    function expectAlert(screen: Screen, message: string) {
        expect(screen.findAllByType(WebAlertModal).map(node => node.props.config))
            .toEqual([expect.objectContaining({ type: 'alert', title: 'common.error', message })]);
        expect(screen.getTextContent()).toContain(message);
        expect(screen.findAllHostsByTestId('web-modal-button-0')).toHaveLength(1);
    }

    afterEach(async () => {
        standardCleanup();
        await act(async () => {
            await account.reset();
            storage.setState(initialStorageState, true);
            publishAppliedActiveServerSnapshot(initialAppliedSnapshot, initialAppliedRuntimeAvailable);
        });
    });

    function makeTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'AskUserQuestion',
            state: 'running',
            input: {
                questions: [
                    {
                        header: 'Q1',
                        question: 'Pick one',
                        multiSelect: false,
                        options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
                    },
                ],
            },
            completedAt: null,
            permission: { id: 'toolu_1', status: 'pending' },
            ...overrides,
        });
    }

    it.each([undefined, '', 'Updates the deployment target.'])(
        'renders an optional option description without raw View text (%j)', async description => {
            const errors = vi.spyOn(console, 'error');
            try {
                const tool = makeTool({ input: { questions: [{
                    question: 'Pick a deployment target', multiSelect: false,
                    options: [{ label: 'Staging', ...(description === undefined ? {} : { description }) }],
                }] } });
                const screen = await renderScreen(React.createElement(AskUserQuestionView, makeToolViewProps(tool, { sessionId: 's1' })));
                expect(screen.findHostByTestId('ask-user-question.option:0:0')).toBeTruthy();
                expect(screen.getTextContent()).toContain('Staging');
                if (description) expect(screen.getTextContent()).toContain(description);
                expect(errors.mock.calls.filter(args => String(args[0]).startsWith('Unexpected text node:'))).toEqual([]);
            } finally { errors.mockRestore(); }
        },
    );

    it('names the authenticated person in the completed question answer byline', async () => {
        const viewer = storage.getState().profileScope;
        expect(viewer?.accountId).toBeTruthy();
        const tool = makeTool({ state: 'completed', result: { status: 'answered', answers: { 'Pick one': ['B'] } },
            permission: { id: 'toolu_1', status: 'approved', answeredBy: { kind: 'person', accountId: viewer!.accountId } } });
        const screen = await renderScreen(React.createElement(AskUserQuestionView, makeToolViewProps(tool, { sessionId: 's1' })));
        expect(screen.getTextContent()).toContain('workflows.run.answeredByYou');
        expect(screen.getTextContent()).toContain('B');
    });

    it('shows serialized structured answers on the completed question card', async () => {
        const tool = makeTool({
            state: 'completed',
            result: JSON.stringify({ status: 'answered', answers: { 'Pick one': ['B'] }, hidden: 'private needle' }),
        });
        const screen = await renderScreen(React.createElement(AskUserQuestionView, makeToolViewProps(tool, { sessionId: 's1' })));

        expect(screen.getTextContent()).toContain('B');
        expect(screen.getTextContent()).not.toContain('Q1 : -');
        expect(projectAskUserQuestionDisplayText(tool)).toEqual([
            { id: 'tool-question-0-answer-label', text: 'Q1:', format: 'plain', kind: 'toolBody' },
            { id: 'tool-question-0-answer', text: 'B', format: 'plain', kind: 'toolBody' },
        ]);
    });

    it('dismisses the exact pending question through the user-action decision and keeps its prompt visible', async () => {
        const screen = await renderScreen(React.createElement(AskUserQuestionView, makeToolViewProps(makeTool(), { sessionId: 's1' })));

        await pressTestInstanceAsync(screen.findByProps({ testID: 'ask-user-question.dismiss' }), 'dismiss question');

        expect(sessionAllowWithAnswers).toHaveBeenCalledExactlyOnceWith({ id: 'toolu_1', decision: 'reject' });
        expect(sendMessage).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('tools.askUserQuestion.dismissed');
        expect(screen.getTextContent()).toContain('Pick one');
        expect(screen.findAllByProps({ testID: 'ask-user-question.submit' })).toHaveLength(0);
    });

    it('renders a settled declined question without a fabricated blank answer', async () => {
        const tool = makeTool({ state: 'completed', result: { status: 'declined' }, permission: { id: 'toolu_1', status: 'denied' } });
        const screen = await renderScreen(React.createElement(AskUserQuestionView, makeToolViewProps(tool, { sessionId: 's1' })));

        expect(screen.getTextContent()).toContain('tools.askUserQuestion.dismissed');
        expect(screen.getTextContent()).toContain('Pick one');
        expect(projectAskUserQuestionDisplayText(tool)).toEqual([
            { id: 'tool-question-0-prompt', text: 'Pick one', format: 'plain', kind: 'toolBody' },
        ]);
    });

    function makeFreeformTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'AskUserQuestion',
            state: 'running',
            input: {
                questions: [
                    {
                        header: 'Q1',
                        question: 'Which file should I inspect?',
                        multiSelect: false,
                        options: [],
                    },
                ],
            },
            completedAt: null,
            permission: { id: 'toolu_1', status: 'pending' },
            ...overrides,
        });
    }

    function publishReviewAskUserQuestionDescriptor(allowedValues: readonly string[], scope: 'account' | 'daemon' = 'account') {
        daemonProjection.agentsById['acme.review']!.ui = {
            behavior: {
                askUserQuestion: {
                    dialogs: [{
                        dialogId: 'review_scope',
                        settingMutation: {
                            settingId: { scope, localId: 'reviewScopePreference' },
                            allowedValues: [...allowedValues],
                        },
                    }],
                },
            },
            session: {}, message: {}, components: { slots: [] },
        };
    }

    function publishAttachedTerminalAskUserQuestionDescriptor() {
        daemonProjection.installedPackagesById['acme.terminal'] = {
            id: 'acme.terminal', displayName: 'Terminal Agent', enabled: true,
            source: { kind: 'local', locator: '/plugins/terminal' },
        };
        daemonProjection.agentsById['acme.terminal'] = {
            id: 'acme.terminal', identity: { pluginId: 'acme.terminal', localId: 'terminal' },
            providerOwnedEnvironmentKeys: [],
            ui: {
                behavior: {
                    attachedSessionTerminal: { supported: true },
                    askUserQuestion: {
                        dialogs: [{
                            dialogId: 'unrecognized_confirmation',
                            terminalNotice: {
                                headerKey: 'tools.askUserQuestion.attachedTerminalNotice.header',
                                questionKey: 'tools.askUserQuestion.attachedTerminalNotice.question',
                            },
                            terminalSecondaryAction: {
                                kind: 'openAttachedTerminal',
                                labelKey: 'tools.askUserQuestion.attachedTerminalNotice.openTerminal',
                                descriptionKey: 'tools.askUserQuestion.attachedTerminalNotice.description',
                            },
                        }],
                    },
                },
                session: {}, message: {}, components: { slots: [] },
            },
        };
    }

    function makeSuggestionsWithFreeformTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'AskUserQuestion',
            state: 'running',
            input: {
                questions: [
                    {
                        header: 'Q1',
                        question: 'What are you trying to achieve?',
                        multiSelect: false,
                        options: [{ label: 'Option A', description: '' }, { label: 'Option B', description: '' }],
                        freeform: { placeholder: 'Other (type below)', description: 'Type a different goal.' },
                    },
                ],
            },
            completedAt: null,
            permission: { id: 'toolu_1', status: 'pending' },
            ...overrides,
        });
    }

    async function renderView(tool: ToolCall, overrides: Record<string, unknown> = {}): Promise<Screen> {
        return renderScreen(React.createElement(
            AskUserQuestionView,
            makeToolViewProps(tool, { sessionId: 's1', ...overrides }),
        ));
    }

    function findPressableByLabel(screen: Screen, label: string) {
        return findTestInstanceByTypeContainingText(screen, 'TouchableOpacity', label);
    }

    async function pressPressableByLabel(screen: Screen, label: string) {
        const target = findPressableByLabel(screen, label);
        expect(target).toBeTruthy();
        await pressTestInstanceAsync(target, label);
    }

    async function chooseOptionAndSubmit(screen: Screen, optionLabel: string) {
        await pressPressableByLabel(screen, optionLabel);
        await pressPressableByLabel(screen, 'tools.askUserQuestion.submit');
    }

    async function fillFreeformAndSubmit(screen: Screen, answer: string) {
        const input = screen.findByProps({ testID: 'ask-user-question.freeform:0' });
        expect(input).toBeTruthy();
        await act(async () => {
            changeTextTestInstance(input, answer, 'ask-user-question freeform input');
        });

        const submit = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submit).toBeTruthy();
        expect(submit!.props.disabled).toBe(false);
        await pressTestInstanceAsync(submit, 'tools.askUserQuestion.submit');
    }

    beforeEach(async () => {
        await account.reset();
        daemonProjection = createQuestionDaemonProjection();
        clearDaemonMergedProjectionCacheForTests();
        await account.restore({ serverIdentityId: 'srv_server_a', features: createRootLayoutFeaturesResponse({ features: { terminal: { embeddedPty: { enabled: true } } } }), machines: [createMachineFixture({ id: 'machine-1', activeAt: Date.now() })] });
        pluginSettingsRecords.clear();
        daemonSettingRequests.length = 0;
        daemonProjectionRequests.length = 0;
        daemonSettingValues = {};
        for (const pluginId of ['happier.agent.claude', 'acme.review']) {
            pluginSettingsRecords.set(pluginId, { revision: 1, values: {} });
            const path = `/v1/account/plugin-settings/${encodeURIComponent(pluginId)}`;
            homes.answer(account.serverId, `GET ${path}`, { select: () => {
                const record = pluginSettingsRecords.get(pluginId)!;
                return { body: PluginAccountSettingsReadResponseV1Schema.parse({
                    status: 'present', revision: record.revision, content: { t: 'plain', v: { v: 1, values: record.values } },
                }) };
            } });
            homes.answer(account.serverId, `POST ${path}`, { select: (input) => {
                const mutation = PluginAccountSettingsMutationRequestV1Schema.parse(input);
                const record = pluginSettingsRecords.get(pluginId)!;
                if (mutation.expectedRevision !== record.revision) return { body: PluginAccountSettingsMutationResponseV1Schema.parse({ status: 'conflict', revision: record.revision }) };
                if (mutation.content?.t !== 'plain') throw new Error('Expected a Plain Account remembered setting');
                record.values = { ...mutation.content.v.values };
                record.revision += 1;
                return { body: PluginAccountSettingsMutationResponseV1Schema.parse({ status: 'updated', revision: record.revision }) };
            } });
        }
        clearProjectedAgentUiBehaviorDescriptors();
        publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId: account.serverId }, 'authority');
        sessionDeny.mockReset();
        sendMessage.mockReset();
        sessionAllowWithAnswers.mockReset();
        questionRpcFailure = null;
        readRequestOutcome.mockReset();
        daemonSessionAttachSupported = true;
        supportsAnswersInPermission = true;
        activeAskUserQuestionRequestId = 'toolu_1';
        activeAskUserQuestionRequest = { tool: 'AskUserQuestion', kind: 'user_action' };
        askUserQuestionSessionState.current = null;
    });

    it('submits answers via permission approval without sending a follow-up user message', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool());
        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: { 'Pick one': ['A'] } });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('preserves the native dialog question id when submitting its stable choice', async () => {
        // QA-UNIFIED-live/32-trust-before.json: the native dialog publishes an id
        // alongside legacy question/options fields; the request owner answers by id.
        const screen = await renderView(makeTool({
            input: {
                happierDialog: { kind: 'recognized', dialogId: 'trust_folder', secondaryAction: 'open_terminal' },
                questions: [{
                    id: 'claudeUnifiedTerminalTrustFolder',
                    header: 'Trust this folder',
                    question: 'Claude needs your permission to trust and run code from this folder.',
                    multiSelect: false,
                    options: [
                        { choice: 'trust_once', label: 'Trust and proceed', description: 'Trust this workspace for this prompt.' },
                        { choice: 'reject_once', label: 'Do not trust', description: 'Reject this workspace for this prompt.' },
                    ],
                }],
            },
        }));

        await chooseOptionAndSubmit(screen, 'Trust and proceed');

        expect(sessionAllowWithAnswers).toHaveBeenCalledExactlyOnceWith({
            id: 'toolu_1', answers: { claudeUnifiedTerminalTrustFolder: ['trust_once'] },
        });
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('answers the qualified Home B request when the same-ID active Home A has no request', async () => {
        activeAskUserQuestionRequest = null;
        const session = createSessionFixture({
            id: 's1', serverId: 'server-b',
            agentState: { requests: { toolu_1: {
                tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 1,
            } } },
        });
        const screen = await renderView(makeTool(), { serverId: 'server-b', session });
        await chooseOptionAndSubmit(screen, 'A');
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: { 'Pick one': ['A'] } });
    });

    describe('when the result of an answer is lost (RPC_OUTCOME_UNKNOWN)', () => {
        const unknownOutcome = () => new HappyError('The outcome is unknown', false, { code: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
        let requestId = '';
        let cases = 0;

        // The unconfirmed set outlives a render, so each case answers its own request.
        async function renderUnknownQuestion() {
            requestId = `toolu_unknown_outcome_${++cases}`;
            activeAskUserQuestionRequestId = requestId;
            sessionAllowWithAnswers.mockRejectedValueOnce(unknownOutcome());
            const screen = await renderView(makeTool({ permission: { id: requestId, status: 'pending' } }));
            await chooseOptionAndSubmit(screen, 'A');
            return screen;
        }
        const notices = (screen: Screen) => screen.findAllHostsByTestId('ask-user-question.answer-unconfirmed');
        const submitDisabled = (screen: Screen) => screen.findByProps({ testID: 'ask-user-question.submit' }).props.accessibilityState.disabled;

        it('withholds the form instead of inviting a resend, with the notice rather than an error alert', async () => {
            const screen = await renderUnknownQuestion();

            expectNoAlert(screen);
            expect(notices(screen)).toHaveLength(1);
            expect(submitDisabled(screen)).toBe(true);
            expect(screen.findByProps({ testID: 'ask-user-question.option:0:1' }).props.accessibilityState.disabled).toBe(true);

            await pressPressableByLabel(screen, 'tools.askUserQuestion.submit');
            expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        });

        it('checks the exact request and releases the form only when the re-read says it is still waiting', async () => {
            const screen = await renderUnknownQuestion();
            readRequestOutcome.mockRejectedValueOnce(new Error('The Session does not say whether the request is still waiting'));

            await pressTestInstanceAsync(screen.findByProps({ testID: 'ask-user-question.check-again' }), 'check again (unreadable)');
            expect(readRequestOutcome).toHaveBeenCalledExactlyOnceWith(requestId);
            expect(notices(screen)).toHaveLength(1);
            expect(screen.getTextContent()).toContain('errors.permissionCheckAgainFailed');
            expect(submitDisabled(screen)).toBe(true);

            readRequestOutcome.mockResolvedValueOnce('pending');
            await pressTestInstanceAsync(screen.findByProps({ testID: 'ask-user-question.check-again' }), 'check again');
            expect(notices(screen)).toHaveLength(0);
            expect(submitDisabled(screen)).toBe(false);

            sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
            await pressPressableByLabel(screen, 'tools.askUserQuestion.submit');
            expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(2);
        });
    });

    it('keeps a provider-submitted answer withheld when the request is still pending', async () => {
        const requestId = 'toolu_submission_unconfirmed';
        activeAskUserQuestionRequestId = requestId;
        questionRpcFailure = { name: 'PluginError', code: 'STRUCTURED_QUESTION_SUBMISSION_UNCONFIRMED',
            message: 'Provider acknowledgment pending', retryable: true };
        const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
        sessionAllowWithAnswers.mockImplementationOnce(createAppSessionTranscriptActions('s1', account.serverId).answerUserAction);
        const screen = await renderView(makeTool({ permission: { id: requestId, status: 'pending' } }));
        await chooseOptionAndSubmit(screen, 'A');

        expectNoAlert(screen);
        expect(screen.findAllHostsByTestId('ask-user-question.answer-unconfirmed')).toHaveLength(1);
        readRequestOutcome.mockResolvedValueOnce('pending');
        await pressTestInstanceAsync(screen.findByProps({ testID: 'ask-user-question.check-again' }), 'check again');

        expect(screen.findByProps({ testID: 'ask-user-question.submit' }).props.accessibilityState.disabled).toBe(true);
        expect(screen.findByProps({ testID: 'ask-user-question.option:0:0' }).props.accessibilityState)
            .toEqual({ checked: true, disabled: true });
        await pressPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
    });

    describe('when Check again finds the question already settled', () => {
        it('keeps the form withheld until the card itself leaves the waiting state', async () => {
            const requestId = 'toolu_unknown_outcome_settled';
            activeAskUserQuestionRequestId = requestId;
            sessionAllowWithAnswers.mockRejectedValueOnce(new HappyError('The outcome is unknown', false, { code: RPC_ERROR_CODES.OUTCOME_UNKNOWN }));
            const screen = await renderView(makeTool({ permission: { id: requestId, status: 'pending' } }));
            await chooseOptionAndSubmit(screen, 'A');

            readRequestOutcome.mockResolvedValueOnce('settled');
            await pressTestInstanceAsync(screen.findByProps({ testID: 'ask-user-question.check-again' }), 'check again');

            expect(readRequestOutcome).toHaveBeenCalledExactlyOnceWith(requestId);
            expect(screen.findByProps({ testID: 'ask-user-question.submit' }).props.accessibilityState.disabled).toBe(true);
            await pressPressableByLabel(screen, 'tools.askUserQuestion.submit');
            expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        });
    });

    it('exposes question choices and submit progress with their current accessible state', async () => {
        const approval = createDeferred<void>();
        sessionAllowWithAnswers.mockImplementationOnce(() => approval.promise);

        const screen = await renderView(makeTool());
        const option = screen.findByProps({ testID: 'ask-user-question.option:0:0' });
        const submitBeforeSelection = screen.findByProps({ testID: 'ask-user-question.submit' });

        expect(option.props.accessibilityRole).toBe('radio');
        expect(option.props.accessibilityState).toEqual({ checked: false, disabled: false });
        expect(submitBeforeSelection.props.accessibilityState).toEqual({ disabled: true, busy: false });

        await pressTestInstanceAsync(option, 'A');

        expect(screen.findByProps({ testID: 'ask-user-question.option:0:0' }).props.accessibilityState)
            .toEqual({ checked: true, disabled: false });
        const submit = screen.findByProps({ testID: 'ask-user-question.submit' });
        expect(submit.props.accessibilityState).toEqual({ disabled: false, busy: false });

        await act(async () => {
            submit.props.onPress();
        });

        expect(screen.findByProps({ testID: 'ask-user-question.submit' }).props.accessibilityState)
            .toEqual({ disabled: true, busy: true });
        expect(screen.findByProps({ testID: 'ask-user-question.option:0:0' }).props.accessibilityState)
            .toEqual({ checked: true, disabled: true });

        approval.resolve();
        await act(async () => {
            await approval.promise;
        });
        expect(screen.findAllByProps({ testID: 'ask-user-question.submit' })).toHaveLength(0);
        expect(screen.findAllByProps({ accessibilityLiveRegion: 'polite' })).toHaveLength(1);
    });

    it('labels freeform answers with the question they answer', async () => {
        const screen = await renderView(makeFreeformTool());
        const input = screen.findByProps({ testID: 'ask-user-question.freeform:0' });

        // The visible header is part of the name, so the field is never separated from its question.
        expect(input.props.accessibilityLabel).toBe('Q1: Which file should I inspect?');
        expect(input.props.accessibilityState).toEqual({ disabled: false });
        const group = screen.findByProps({ testID: 'ask-user-question.question:0' });
        expect(group.props.role).toBe('group');
        expect(group.props.accessibilityLabel).toBe('Q1: Which file should I inspect?');
    });

    it('submits canonical multiple-choice answers by stable question and choice ids while allowing optional omissions', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool({
            input: {
                title: 'Implementation choices',
                questions: [
                    {
                        id: 'components',
                        question: 'Which components should change?',
                        required: true,
                        selection: 'multiple',
                        options: [
                            { id: 'api, gateway', label: 'API, gateway', description: 'Update the API gateway.' },
                            { id: 'ui', label: 'UI', description: 'Update the UI.' },
                        ],
                    },
                    {
                        id: 'notes',
                        question: 'Anything else?',
                        required: false,
                        selection: 'text',
                        presentation: {
                            inputMode: 'singleLine',
                            placeholder: 'Optional notes',
                            whitespace: 'trim',
                            allowEmpty: false,
                        },
                    },
                ],
            },
        }));

        const firstChoice = screen.findByProps({ testID: 'ask-user-question.option:0:0' });
        expect(firstChoice.props.accessibilityRole).toBe('checkbox');
        expect(firstChoice.props.accessibilityState).toEqual({ checked: false, disabled: false });

        await pressPressableByLabel(screen, 'API, gateway');
        await pressPressableByLabel(screen, 'UI');

        const submit = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submit).toBeTruthy();
        expect(submit!.props.disabled).toBe(false);
        await pressTestInstanceAsync(submit, 'tools.askUserQuestion.submit');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: {
            components: ['api, gateway', 'ui'],
        } });
    });

    it('requires the declared selected-option count independently of custom text', async () => {
        const screen = await renderView(makeTool({ input: { questions: [{
            id: 'components', question: 'Which components?', required: true, selection: 'multiple',
            minSelections: 2, maxSelections: 2, allowCustom: true,
            options: [{ id: 'api', label: 'API' }, { id: 'ui', label: 'UI' }, { id: 'cli', label: 'CLI' }],
        }] } }));
        await pressPressableByLabel(screen, 'API');
        await act(async () => { changeTextTestInstance(screen.findByProps({ testID: 'ask-user-question.freeform:0' }),
            'Custom, other', 'custom question answer'); });
        expect(screen.findByProps({ testID: 'ask-user-question.submit' }).props.accessibilityState.disabled).toBe(true);
        await pressPressableByLabel(screen, 'UI');
        expect(screen.findByProps({ testID: 'ask-user-question.submit' }).props.accessibilityState.disabled).toBe(false);
        await pressPressableByLabel(screen, 'CLI');
        expect(screen.findByProps({ testID: 'ask-user-question.submit' }).props.accessibilityState.disabled).toBe(true);
        await pressPressableByLabel(screen, 'CLI');
        await pressPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: { components: ['api', 'ui'] },
            answerDetails: { components: { freeText: 'Custom, other' } } });
    });

    it('honors canonical text presentation and preserves whitespace and commas', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool({
            input: {
                questions: [{
                    id: 'notes',
                    question: 'Add implementation notes',
                    required: true,
                    selection: 'text',
                    presentation: {
                        inputMode: 'multiLine',
                        placeholder: 'Type notes',
                        whitespace: 'preserve',
                        allowEmpty: false,
                    },
                }],
            },
        }));

        const input = screen.findByProps({ testID: 'ask-user-question.freeform:0' });
        expect(input.props.multiline).toBe(true);
        expect(input.props.placeholder).toBe('Type notes');
        await act(async () => {
            changeTextTestInstance(input, '  first, second  ', 'canonical question text input');
        });
        await pressPressableByLabel(screen, 'tools.askUserQuestion.submit');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: {
            notes: ['  first, second  '],
        } });
    });

    it('uses canonical text initial content as the editable answer', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool({
            input: {
                questions: [{
                    id: 'notes',
                    question: 'Edit release notes',
                    required: true,
                    selection: 'text',
                    presentation: {
                        inputMode: 'multiLine',
                        initialValue: 'Existing notes',
                        whitespace: 'preserve',
                        allowEmpty: false,
                    },
                }],
            },
        }));

        const input = screen.findByProps({ testID: 'ask-user-question.freeform:0' });
        expect(input.props.value).toBe('Existing notes');
        await pressPressableByLabel(screen, 'tools.askUserQuestion.submit');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: {
            notes: ['Existing notes'],
        } });
    });

    it('submits canonical custom single-choice text separately from selected ids under the question id', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool({
            input: {
                questions: [{
                    id: 'goal',
                    question: 'What are you trying to achieve?',
                    required: true,
                    selection: 'single',
                    options: [{ id: 'ship', label: 'Ship it' }],
                    allowCustom: true,
                }],
            },
        }));

        await fillFreeformAndSubmit(screen, 'Custom goal, with commas');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: {
            goal: [],
        }, answerDetails: { goal: { freeText: 'Custom goal, with commas' } } });
    });

    it('sends a question\'s optional note beside its answer, and offers the note only where the question allows one', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool({
            input: {
                questions: [{
                    id: 'duplicates',
                    question: 'When the same event arrives twice, what should the handler return?',
                    required: true,
                    selection: 'single',
                    options: [{ id: 'ok', label: '200 OK, and skip it' }, { id: 'conflict', label: '409 Conflict' }],
                    allowNote: true,
                }, {
                    id: 'cases',
                    question: 'Which cases should the test cover?',
                    required: false,
                    selection: 'multiple',
                    options: [{ id: 'twice', label: 'Same event twice' }],
                }],
            },
        }));

        expect(screen.findAllByProps({ testID: 'ask-user-question.note:1' })).toHaveLength(0);
        await pressPressableByLabel(screen, '200 OK, and skip it');
        await act(async () => {
            changeTextTestInstance(screen.findByProps({ testID: 'ask-user-question.note:0' }),
                '  Log the duplicate with its event id  ', 'ask-user-question note input');
        });
        const submit = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        await pressTestInstanceAsync(submit, 'tools.askUserQuestion.submit');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: {
            duplicates: ['ok'],
        }, answerDetails: { duplicates: { note: 'Log the duplicate with its event id' } } });
    });

    it('preserves selected choices and custom text separately for a canonical multiple-choice answer', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool({
            input: {
                questions: [{
                    id: 'components',
                    question: 'Which components should change?',
                    required: true,
                    selection: 'multiple',
                    options: [
                        { id: 'api, gateway', label: 'API, gateway' },
                        { id: 'ui', label: 'UI' },
                    ],
                    allowCustom: true,
                }],
            },
        }));

        await pressPressableByLabel(screen, 'API, gateway');
        await pressPressableByLabel(screen, 'UI');
        await fillFreeformAndSubmit(screen, 'Custom, other');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: {
            components: ['api, gateway', 'ui'],
        }, answerDetails: { components: { freeText: 'Custom, other' } } });
    });

    it('opens a terminal-only dialog without resolving the permission request', async () => {
        const screen = await renderView(makeTool({
            input: {
                happierDialog: {
                    kind: 'unrecognized',
                    mode: 'notice',
                    dialogId: 'unrecognized_confirmation',
                    action: 'open_terminal',
                },
                questions: [{ header: 'Claude dialog', question: 'Open terminal?', multiSelect: false, options: [] }],
            },
        }));

        const action = screen.findByProps({ testID: 'ask-user-question.open-attached-terminal' });
        await pressTestInstanceAsync(action, 'Open attached terminal');

        expect(readSessionTerminalMode('s1', account.serverId)).toBe('session_attach');
        expect(sessionAllowWithAnswers).not.toHaveBeenCalled();
        expect(screen.findAllByProps({ testID: 'ask-user-question.submit' })).toHaveLength(0);
    });

    it('replaces an optionless terminal-notice prompt with the host notice copy', async () => {
        publishAttachedTerminalAskUserQuestionDescriptor();
        askUserQuestionSessionState.current = {
            serverId: account.serverId,
            metadataLayoutVersion: 1,
            ownerMetadataView: {
                machineId: 'machine-1',
                runtimeDescriptorV1: { v: 1, agentId: 'acme.terminal', agent: {} },
            },
            agentState: {
                capabilities: { askUserQuestionAnswersInPermission: true },
                requests: {
                    toolu_1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: {},
                        createdAt: 1,
                    },
                },
            },
        };
        const screen = await renderView(makeTool({
            input: {
                happierDialog: {
                    kind: 'unrecognized',
                    mode: 'notice',
                    dialogId: 'unrecognized_confirmation',
                    action: 'open_terminal',
                },
                questions: [{ header: 'Claude dialog', question: 'Open terminal?', multiSelect: false, options: [] }],
            },
        }));

        expect(findTestInstanceByTypeContainingText(
            screen,
            'Text',
            'tools.askUserQuestion.attachedTerminalNotice.header',
        )).toBeTruthy();
        expect(findTestInstanceByTypeContainingText(
            screen,
            'Text',
            'tools.askUserQuestion.attachedTerminalNotice.question',
        )).toBeTruthy();
        // The raw TUI prompt text never reaches the user.
        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'Open terminal?')).toBeUndefined();
    });

    it('leaves a terminal-notice prompt that still offers choices on its own copy', async () => {
        const screen = await renderView(makeTool({
            input: {
                happierDialog: {
                    kind: 'unrecognized',
                    mode: 'notice',
                    dialogId: 'unrecognized_confirmation',
                    action: 'open_terminal',
                },
                questions: [{
                    header: 'Claude dialog',
                    question: 'Trust this folder?',
                    multiSelect: false,
                    options: [{ label: 'Yes', description: '' }],
                }],
            },
        }));

        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'Trust this folder?')).toBeTruthy();
        expect(findTestInstanceByTypeContainingText(
            screen,
            'Text',
            'tools.askUserQuestion.attachedTerminalNotice.question',
        )).toBeUndefined();
    });

    it('explains when a terminal-only dialog cannot open an attached terminal', async () => {
        daemonSessionAttachSupported = false;
        const screen = await renderView(makeTool({
            input: {
                happierDialog: {
                    kind: 'unrecognized',
                    mode: 'notice',
                    dialogId: 'unrecognized_confirmation',
                    action: 'open_terminal',
                },
                questions: [{ header: 'Claude dialog', question: 'Open terminal?', multiSelect: false, options: [] }],
            },
        }));

        expect(screen.findAllByProps({ testID: 'ask-user-question.open-attached-terminal' })).toHaveLength(0);
        expect(screen.findByProps({ testID: 'ask-user-question.attached-terminal-unavailable' })).toBeTruthy();
        expect(findTestInstanceByTypeContainingText(screen, 'Text', 'deps.ui.notAvailableUpdateCli')).toBeTruthy();
        expect(screen.findAllByProps({ testID: 'ask-user-question.submit' })).toHaveLength(0);
    });

    it('keeps recognized choices answerable while explaining that the attached terminal is unavailable', async () => {
        daemonSessionAttachSupported = false;
        const screen = await renderView(makeTool({
            input: {
                happierDialog: { kind: 'recognized', dialogId: 'trust_folder', secondaryAction: 'open_terminal' },
                questions: [{
                    header: 'Workspace trust',
                    question: 'How should Claude continue?',
                    multiSelect: false,
                    options: [{ choice: 'trust_once', label: 'Trust once', description: '' }],
                }],
            },
        }));

        expect(screen.findAllByProps({ testID: 'ask-user-question.open-attached-terminal' })).toHaveLength(0);
        expect(screen.findByProps({ testID: 'ask-user-question.attached-terminal-unavailable' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'ask-user-question.submit' })).toBeTruthy();
    });

    it('fails closed when an option mutation is outside the current dialog allowlist', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool({
            input: {
                happierDialog: { kind: 'recognized', dialogId: 'trust_folder', secondaryAction: 'open_terminal' },
                questions: [{
                    header: 'Workspace trust',
                    question: 'How should Claude continue?',
                    multiSelect: false,
                    options: [{
                        choice: 'trust_always',
                        label: 'Trust and remember',
                        description: '',
                        settingMutation: {
                            settingId: 'claudeUnifiedTerminalWorkspaceTrust',
                            value: 'always_trust_everything',
                        },
                    }],
                }],
            },
        }));

        expect(screen.findByProps({ testID: 'ask-user-question.open-attached-terminal' })).toBeTruthy();
        await chooseOptionAndSubmit(screen, 'Trust and remember');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: {
            'How should Claude continue?': ['trust_always'],
        } });
        expect([...pluginSettingsRecords.values()]).toEqual([{ revision: 1, values: {} }, { revision: 1, values: {} }]);
        expect(daemonSettingRequests).toEqual([]);
        expect(storage.getState().settings).not.toHaveProperty('claudeUnifiedTerminalWorkspaceTrust');
    });

    it('persists recognized workspace trust through its current qualified declaration', async () => {
        activeAskUserQuestionRequest = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
        };
        askUserQuestionSessionState.current = {
            serverId: account.serverId,
            metadataLayoutVersion: 1,
            metadata: { machineId: 'shared-decoy-machine' },
            ownerMetadataView: {
                machineId: 'machine-1',
                runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
            },
            agentState: {
                capabilities: { askUserQuestionAnswersInPermission: true },
                requests: {
                    toolu_1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: {},
                        createdAt: 1,
                    },
                },
            },
        };
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool({
            input: {
                happierDialog: { kind: 'recognized', dialogId: 'trust_folder', secondaryAction: 'open_terminal' },
                questions: [{
                    header: 'Workspace trust',
                    question: 'How should Claude continue?',
                    multiSelect: false,
                    options: [{
                        choice: 'trust_always',
                        label: 'Trust and remember',
                        description: '',
                        settingMutation: {
                            settingId: 'claudeUnifiedTerminalWorkspaceTrust',
                            value: 'always_trust_happier_workspaces',
                        },
                    }],
                }],
            },
        }));

        await chooseOptionAndSubmit(screen, 'Trust and remember');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: {
            'How should Claude continue?': ['trust_always'],
        } });
        // Claude declares both remembered choices in its single `scope: 'account'`
        // Agent Settings contribution, and its runtime reads them back through
        // `services.settings.forScope({ kind: 'account' })`. A daemon-scoped
        // operation is refused by the daemon's exact-declaration filter, so the
        // user's answer would settle while the preference silently disappeared.
        expect(daemonSettingRequests).toEqual([]);
        expect(pluginSettingsRecords.get('happier.agent.claude')).toEqual({ revision: 2, values: {
            claudeUnifiedTerminalWorkspaceTrust: 'always_trust_happier_workspaces',
        } });
        expect(homes.requestsFor('/v1/account/plugin-settings/happier.agent.claude').filter(request => request.input !== null)).toEqual([
            expect.objectContaining({ serverId: account.serverId, input: {
                expectedRevision: 1, content: { t: 'plain', v: { v: 1, values: { claudeUnifiedTerminalWorkspaceTrust: 'always_trust_happier_workspaces' } } },
            } }),
        ]);
        expect(storage.getState().settings).not.toHaveProperty('claudeUnifiedTerminalWorkspaceTrust');
    });

    it('persists an external Agent choice through its own qualified settings declaration', async () => {
        publishReviewAskUserQuestionDescriptor(['always_include']);
        // Account Settings admission reads the selected release declaration;
        // a daemon's current Agent descriptor alone cannot authorize that write.
        const intentRead = PluginAvailabilityIntentReadActionOutputV1Schema.parse({
            availabilityCursor: 1, hostingCapability: { enabled: false },
            intent: { pluginId: 'acme.review', desiredVersion: '1.0.0', enabled: true,
                offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
            release: { ref: { pluginId: 'acme.review', version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                normalizedManifest: { schemaVersion: 2, id: 'acme.review', version: '1.0.0', displayName: 'Review',
                    engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: { settings: [{
                        id: 'settings', title: 'Remembered choices', scope: 'account',
                        target: { kind: 'agent', agent: { pluginId: 'acme.review', localId: 'review' } },
                        fields: [{ id: 'reviewScopePreference', title: 'Review scope',
                            schema: { type: 'string', enum: ['ask_every_time', 'always_include'] } }],
                    }] } }, collectionContracts: [], uiSlots: [],
                packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            packageAssets: [], uiArtifacts: [],
        });
        homes.answer(account.serverId, `POST ${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']}`, {
            body: PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 1, snapshots: [] }),
        });
        homes.answer(account.serverId, `POST ${PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']}`, {
            body: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1, pluginIds: ['acme.review'],
                intentReads: [{ pluginId: 'acme.review', response: intentRead }], failedPluginIds: [], nextCursor: null }),
        });
        const [{ createActivePluginAccountAvailabilityProjectionHydrator }, { applyPluginAccountAvailabilityProjectionRefresh, readPluginAccountAvailability }] = await Promise.all([
            import('@/sync/api/plugins/availability/pluginAvailabilityProjection'),
            import('@/sync/domains/plugins/availability/projection'),
        ]);
        const availability = await createActivePluginAccountAvailabilityProjectionHydrator().refresh();
        if (!availability) throw new Error('Question Account Availability scope retired');
        applyPluginAccountAvailabilityProjectionRefresh(availability);
        expect(readPluginAccountAvailability({ serverId: account.serverId, accountId: 'account-a' })
            .readCurrentSettingsDeclaration({ pluginId: 'acme.review' })).toMatchObject({ kind: 'available' });
        askUserQuestionSessionState.current = {
            serverId: account.serverId,
            metadataLayoutVersion: 1,
            ownerMetadataView: {
                machineId: 'machine-1',
                runtimeDescriptorV1: { v: 1, agentId: 'acme.review', agent: {} },
            },
            agentState: {
                capabilities: { askUserQuestionAnswersInPermission: true },
                requests: {
                    toolu_1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: {},
                        createdAt: 1,
                    },
                },
            },
        };
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool({
            input: {
                happierDialog: { kind: 'recognized', dialogId: 'review_scope' },
                questions: [{
                    header: 'Review scope',
                    question: 'Remember this scope?',
                    multiSelect: false,
                    options: [{
                        choice: 'always_include',
                        label: 'Always include selected files',
                        description: '',
                        settingMutation: {
                            settingId: 'reviewScopePreference',
                            value: 'always_include',
                        },
                    }],
                }],
            },
        }));

        await chooseOptionAndSubmit(screen, 'Always include selected files');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: {
            'Remember this scope?': ['always_include'],
        } });
        expect(daemonSettingRequests).toEqual([]);
        expect(pluginSettingsRecords.get('acme.review'), screen.getTextContent()).toEqual({ revision: 2, values: {
            reviewScopePreference: 'always_include',
        } });
        expect(homes.requestsFor('/v1/account/plugin-settings/acme.review').filter(request => request.input !== null)).toEqual([
            expect.objectContaining({ serverId: account.serverId, input: {
                expectedRevision: 1, content: { t: 'plain', v: { v: 1, values: { reviewScopePreference: 'always_include' } } },
            } }),
        ]);
        expect(storage.getState().settings).not.toHaveProperty('reviewScopePreference');
    });

    it('uses the external Agent setting catalog scope instead of forcing an Account write', async () => {
        publishReviewAskUserQuestionDescriptor(['always_include'], 'daemon');
        daemonProjection.settingsById['acme.review.settings']!.scope.kind = 'daemon';
        askUserQuestionSessionState.current = {
            serverId: account.serverId,
            metadataLayoutVersion: 1,
            ownerMetadataView: {
                machineId: 'machine-1',
                runtimeDescriptorV1: { v: 1, agentId: 'acme.review', agent: {} },
            },
            agentState: {
                capabilities: { askUserQuestionAnswersInPermission: true },
                requests: {
                    toolu_1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: {},
                        createdAt: 1,
                    },
                },
            },
        };
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool({
            input: {
                happierDialog: { kind: 'recognized', dialogId: 'review_scope' },
                questions: [{
                    header: 'Review scope',
                    question: 'Remember this scope?',
                    multiSelect: false,
                    options: [{
                        choice: 'always_include',
                        label: 'Always include selected files',
                        description: '',
                        settingMutation: {
                            settingId: 'reviewScopePreference',
                            value: 'always_include',
                        },
                    }],
                }],
            },
        }));

        await chooseOptionAndSubmit(screen, 'Always include selected files');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(daemonSettingRequests).toEqual([{
            serverIdentityId: 'srv_server_a', machineId: 'machine-1', pluginId: 'acme.review',
            fieldId: 'reviewScopePreference', mutation: { kind: 'set', value: 'always_include' },
            expectedRevision: 'revision-1', scope: { kind: 'daemon' },
        }]);
        expect(daemonSettingValues).toEqual({ reviewScopePreference: 'always_include' });
        expect(pluginSettingsRecords.get('acme.review')).toEqual({ revision: 1, values: {} });
    });

    it('refuses a remembered choice when the owning Agent projection changes while approval is in flight', async () => {
        publishReviewAskUserQuestionDescriptor(['always_include']);
        askUserQuestionSessionState.current = {
            serverId: account.serverId,
            metadataLayoutVersion: 1,
            ownerMetadataView: {
                machineId: 'machine-1',
                runtimeDescriptorV1: { v: 1, agentId: 'acme.review', agent: {} },
            },
            agentState: {
                capabilities: { askUserQuestionAnswersInPermission: true },
                requests: {
                    toolu_1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        arguments: {},
                        createdAt: 1,
                    },
                },
            },
        };
        const approval = createDeferred<void>();
        sessionAllowWithAnswers.mockImplementationOnce(() => approval.promise);
        const tool = makeTool({
            input: {
                happierDialog: { kind: 'recognized', dialogId: 'review_scope' },
                questions: [{
                    header: 'Review scope',
                    question: 'Remember this scope?',
                    multiSelect: false,
                    options: [{
                        choice: 'always_include',
                        label: 'Always include selected files',
                        description: '',
                        settingMutation: {
                            settingId: 'reviewScopePreference',
                            value: 'always_include',
                        },
                    }],
                }],
            },
        });
        const screen = await renderView(tool);

        await pressPressableByLabel(screen, 'Always include selected files');
        const submit = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submit).toBeTruthy();
        await act(async () => {
            submit!.props.onPress();
        });
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: {
            'Remember this scope?': ['always_include'],
        } });

        // The owning Agent replaces only this dialog's allowlist while the
        // approval is in flight. The field remains current and writable, so
        // an old render closure would wrongly persist its now-disallowed
        // choice. The real invalidation also refreshes the subscribed hook;
        // settlement must use the canonical projection/descriptor currentness.
        publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId: account.serverId }, 'authority');
        daemonProjection.generation += 1;
        publishReviewAskUserQuestionDescriptor([]);

        approval.resolve();
        await act(async () => {
            await approval.promise;
        });

        expect([...pluginSettingsRecords.values()]).toEqual([{ revision: 1, values: {} }, { revision: 1, values: {} }]);
        expect(daemonSettingRequests).toEqual([]);
    });

    it('persists a remembered resume policy through the same scoped plugin settings owner', async () => {
        activeAskUserQuestionRequest = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            source: 'claude_unified_terminal_dialog_choice',
        };
        askUserQuestionSessionState.current = {
            serverId: account.serverId,
            metadataLayoutVersion: 1,
            ownerMetadataView: {
                machineId: 'machine-1',
                runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
            },
            agentState: {
                capabilities: { askUserQuestionAnswersInPermission: true },
                requests: {
                    toolu_1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        source: 'claude_unified_terminal_dialog_choice',
                        arguments: {},
                        createdAt: 1,
                    },
                },
            },
        };
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool({
            input: {
                happierDialog: { kind: 'recognized', dialogId: 'resume_choice', secondaryAction: 'open_terminal' },
                questions: [{
                    header: 'Claude resume',
                    question: 'How should Claude resume this session?',
                    multiSelect: false,
                    options: [{
                        choice: 'always_resume_from_summary',
                        label: 'Always resume from summary',
                        description: '',
                        settingMutation: {
                            settingId: 'claudeUnifiedTerminalResumeChoice',
                            value: 'resume_from_summary',
                        },
                    }],
                }],
            },
        }));

        await chooseOptionAndSubmit(screen, 'Always resume from summary');

        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: {
            'How should Claude resume this session?': ['always_resume_from_summary'],
        } });
        expect(pluginSettingsRecords.get('happier.agent.claude')).toEqual({ revision: 2, values: {
            claudeUnifiedTerminalResumeChoice: 'resume_from_summary',
        } });
        expect(homes.requestsFor('/v1/account/plugin-settings/happier.agent.claude').filter(request => request.input !== null)).toEqual([
            expect.objectContaining({ serverId: account.serverId, input: {
                expectedRevision: 1, content: { t: 'plain', v: { v: 1, values: { claudeUnifiedTerminalResumeChoice: 'resume_from_summary' } } },
            } }),
        ]);
    });

    it('fails closed when workspace trust has no portable server identity', async () => {
        activeAskUserQuestionRequest = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            source: 'claude_unified_terminal_dialog_choice',
        };
        askUserQuestionSessionState.current = {
            serverId: account.serverId,
            metadataLayoutVersion: 1,
            ownerMetadataView: {
                machineId: 'machine-1',
                runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
            },
            agentState: {
                capabilities: { askUserQuestionAnswersInPermission: true },
                requests: {
                    toolu_1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        source: 'claude_unified_terminal_dialog_choice',
                        arguments: {},
                        createdAt: 1,
                    },
                },
            },
        };
        // A manually saved Home can serve its machine projection while it has
        // not published a portable identity for Account settings targets.
        await account.reset();
        await account.restore({ machines: [createMachineFixture({ id: 'machine-1', activeAt: Date.now() })] });
        askUserQuestionSessionState.current = { ...askUserQuestionSessionState.current, serverId: account.serverId };
        clearDaemonMergedProjectionCacheForTests();
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool({
            input: {
                happierDialog: { kind: 'recognized', dialogId: 'trust_folder', secondaryAction: 'open_terminal' },
                questions: [{
                    header: 'Workspace trust',
                    question: 'How should Claude continue?',
                    multiSelect: false,
                    options: [{
                        choice: 'trust_always',
                        label: 'Trust and remember',
                        description: '',
                        settingMutation: {
                            settingId: 'claudeUnifiedTerminalWorkspaceTrust',
                            value: 'always_trust_happier_workspaces',
                        },
                    }],
                }],
            },
        }));

        await chooseOptionAndSubmit(screen, 'Trust and remember');

        expect([...pluginSettingsRecords.values()]).toEqual([{ revision: 1, values: {} }, { revision: 1, values: {} }]);
        expect(daemonSettingRequests).toEqual([]);
        expectAlert(screen, 'Unable to persist the selected setting without an exact Account target.');
    });

    it('does not persist a remembered choice without the session machine and Agent identity', async () => {
        activeAskUserQuestionRequest = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            source: 'claude_unified_terminal_dialog_choice',
        };
        // Layout1 `metadata.machineId` is a shared decoy and there is no owner
        // view. The Account record is not machine-addressed, but the host must
        // still resolve the exact session Agent descriptor before accepting a
        // candidate mutation from a tool payload.
        askUserQuestionSessionState.current = {
            serverId: account.serverId,
            metadataLayoutVersion: 1,
            metadata: { machineId: 'shared-decoy-machine' },
            ownerMetadataView: null,
            agentState: {
                capabilities: { askUserQuestionAnswersInPermission: true },
                requests: {
                    toolu_1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        source: 'claude_unified_terminal_dialog_choice',
                        arguments: {},
                        createdAt: 1,
                    },
                },
            },
        };
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool({
            input: {
                happierDialog: { kind: 'recognized', dialogId: 'trust_folder', secondaryAction: 'open_terminal' },
                questions: [{
                    header: 'Workspace trust',
                    question: 'How should Claude continue?',
                    multiSelect: false,
                    options: [{
                        choice: 'trust_always',
                        label: 'Trust and remember',
                        description: '',
                        settingMutation: {
                            settingId: 'claudeUnifiedTerminalWorkspaceTrust',
                            value: 'always_trust_happier_workspaces',
                        },
                    }],
                }],
            },
        }));

        await chooseOptionAndSubmit(screen, 'Trust and remember');

        expectNoAlert(screen);
        expect([...pluginSettingsRecords.values()]).toEqual([{ revision: 1, values: {} }, { revision: 1, values: {} }]);
        expect(daemonSettingRequests).toEqual([]);
    });

    it.each(['unavailable', 'applied'] as const)('keeps an accepted answer settled when its remembered preference returns %s', async (settlement) => {
        activeAskUserQuestionRequest = {
            tool: 'AskUserQuestion',
            kind: 'user_action',
            source: 'claude_unified_terminal_dialog_choice',
        };
        askUserQuestionSessionState.current = {
            serverId: account.serverId,
            metadataLayoutVersion: 1,
            ownerMetadataView: {
                machineId: 'machine-1',
                runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
            },
            agentState: {
                capabilities: { askUserQuestionAnswersInPermission: true },
                requests: {
                    toolu_1: {
                        tool: 'AskUserQuestion',
                        kind: 'user_action',
                        source: 'claude_unified_terminal_dialog_choice',
                        arguments: {},
                        createdAt: 1,
                    },
                },
            },
        };
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        if (settlement === 'unavailable') homes.answer(account.serverId, 'POST /v1/account/plugin-settings/happier.agent.claude', {
            status: 503, body: { error: 'plugin_account_settings_storage_unavailable' },
        });
        const screen = await renderView(makeTool({
            input: {
                happierDialog: { kind: 'recognized', dialogId: 'trust_folder', secondaryAction: 'open_terminal' },
                questions: [{
                    header: 'Workspace trust',
                    question: 'How should Claude continue?',
                    multiSelect: false,
                    options: [{
                        choice: 'trust_always',
                        label: 'Trust and remember',
                        description: '',
                        settingMutation: {
                            settingId: 'claudeUnifiedTerminalWorkspaceTrust',
                            value: 'always_trust_happier_workspaces',
                        },
                    }],
                }],
            },
        }));

        await chooseOptionAndSubmit(screen, 'Trust and remember');

        // The answer reached the agent exactly once and is terminal. Only the
        // side-effecting preference failed, so the dialog must not re-offer a
        // submit affordance that would answer the same request twice.
        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(findPressableByLabel(screen, 'tools.askUserQuestion.submit')).toBeFalsy();
        if (settlement === 'applied') {
            expectNoAlert(screen);
        } else {
            expectAlert(screen, 'Unable to persist the selected setting.');
        }
    });

    it('exposes stable testIDs for native E2E (Maestro)', async () => {
        const screen = await renderView(makeTool());

        expect(screen.findByProps({ testID: 'ask-user-question' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'ask-user-question.option:0:0' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'ask-user-question.option:0:1' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'ask-user-question.submit' })).toBeTruthy();
    });

    it('falls back to tool.id when permission metadata is missing but the matching request is still active', async () => {
        activeAskUserQuestionRequestId = 'toolu_reconnect';
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool({ id: 'toolu_reconnect', permission: undefined }));

        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_reconnect', answers: { 'Pick one': ['A'] } });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
        expectNoAlert(screen);
    });

    it('does not allow answering when no permission request id is available', async () => {
        const screen = await renderView(makeTool({ id: undefined, permission: undefined }));

        const option = findPressableByLabel(screen, 'A');
        expect(option).toBeTruthy();
        await pressTestInstanceAsync(option, 'A');

        const submit = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submit).toBeUndefined();

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
        expectNoAlert(screen);
    });

    it('shows an error when permission approval fails', async () => {
        sessionAllowWithAnswers.mockRejectedValueOnce(new Error('boom'));

        const screen = await renderView(makeTool());
        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
        expectAlert(screen, 'boom');
    });

    it('uses permission approval when answers-in-permission capability is unavailable but the matching request is still active', async () => {
        supportsAnswersInPermission = false;
        activeAskUserQuestionRequest = { tool: 'AskUserQuestion', kind: 'user_action' };
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeTool());
        await chooseOptionAndSubmit(screen, 'A');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: { 'Pick one': ['A'] } });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('does not allow answering when the matching AskUserQuestion request is no longer active', async () => {
        supportsAnswersInPermission = true;
        activeAskUserQuestionRequest = null;

        const screen = await renderView(makeTool());

        const option = findPressableByLabel(screen, 'A');
        expect(option).toBeTruthy();
        await pressTestInstanceAsync(option, 'A');

        const submit = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submit).toBeUndefined();
        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('does not allow answering when conversational Send is unavailable', async () => {
        const screen = await renderView(
            makeTool(),
            {
                interaction: {
                    canSendMessages: false,
                    canApprovePermissions: false,
                    permissionDisabledReason: 'notGranted',
                },
            },
        );

        const option = findPressableByLabel(screen, 'A');
        expect(option).toBeTruthy();
        await pressTestInstanceAsync(option, 'A');

        const submit = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submit).toBeUndefined();

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(0);
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);

        const texts = screen.getTextContent();
        expect(texts).toContain('session.sharing.permissionApprovalsDisabledNotGranted');
    });

    it('answers an agent question with Send authority when permission approval is unavailable', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);
        const screen = await renderView(makeTool(), {
            interaction: { canSendMessages: true, canApprovePermissions: false },
        });
        await chooseOptionAndSubmit(screen, 'A');
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: { 'Pick one': ['A'] } });
        expect(sessionDeny).not.toHaveBeenCalled();
    });

    it('does not answer a stale running question when the Session is inactive', async () => {
        const screen = await renderView(makeTool(), {
            interaction: { canSendMessages: true, canApprovePermissions: false, permissionDisabledReason: 'inactive' },
        });
        expect(screen.findAllByTestId('ask-user-question.submit')).toHaveLength(0);
        expect(sessionAllowWithAnswers).not.toHaveBeenCalled();
    });

    it.each(['waiting', 'completed', 'cancelled', 'failed'] as const)('uses the canonical historical-Turn question projection for %s cards', async status => {
        activeAskUserQuestionRequest = { tool: 'AskUserQuestion', kind: 'user_action', turnId: 'older-turn' };
        askUserQuestionSessionState.current = { archivedAt: null, latestTurnId: 'newer-turn', latestTurnStatus: 'completed',
            sessionTurns: buildSessionTurnsProjectionV1({ sessionId: 's1', updatedAt: 200,
                turns: [{ turnId: 'older-turn', status, startedAt: 1, updatedAt: 200 }] }) };
        const screen = await renderView(makeTool());
        if (status !== 'cancelled') {
            expect(screen.findAllByTestId('ask-user-question.withdrawn')).toHaveLength(0);
            await chooseOptionAndSubmit(screen, 'A');
            expect(sessionAllowWithAnswers).toHaveBeenCalledOnce();
        } else {
            expect(screen.findHostByTestId('ask-user-question.withdrawn')).toBeTruthy();
            expect(screen.findAllByTestId('ask-user-question.submit')).toHaveLength(0);
            expect(screen.findAllByTestId('ask-user-question.dismiss')).toHaveLength(0);
            expect(sessionAllowWithAnswers).not.toHaveBeenCalled();
        }
    });

    it('withdraws submit when a read-only source contains a pending agent question', async () => {
        const screen = await renderWithSessionTranscriptSource(
            React.createElement(AppPaneProvider, { children: React.createElement(AskUserQuestionView, makeToolViewProps(makeTool(), { sessionId: 's1' })) }),
            createTestSessionTranscriptSource({ agentState: readSessionFixture().agentState }),
        );
        expect(screen.findAllByTestId('ask-user-question.submit')).toHaveLength(0);
        expect(sessionAllowWithAnswers).not.toHaveBeenCalled();
    });

    it('answers an execution-run question through its responder without Session authority', async () => {
        const respond = vi.fn(async () => {});
        const screen = await renderView(makeTool(), {
            sessionId: undefined,
            executionRun: { executionRunId: 'run1', respond, pendingRequestIds: new Set() },
        });
        await chooseOptionAndSubmit(screen, 'A');
        expect(respond).toHaveBeenCalledWith({ requestId: 'toolu_1', answers: { 'Pick one': ['A'] } });
        expect(sessionAllowWithAnswers).not.toHaveBeenCalled();
        expect(sessionDeny).not.toHaveBeenCalled();
    });

    it('dismisses an execution-run question through its existing responder without Session authority', async () => {
        const respond = vi.fn(async () => {});
        const screen = await renderView(makeTool(), {
            sessionId: undefined,
            executionRun: { executionRunId: 'run1', respond, pendingRequestIds: new Set() },
        });

        await pressTestInstanceAsync(screen.findByProps({ testID: 'ask-user-question.dismiss' }), 'dismiss question');

        expect(respond).toHaveBeenCalledExactlyOnceWith({ requestId: 'toolu_1', approved: false });
        expect(sessionAllowWithAnswers).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('tools.askUserQuestion.dismissed');
    });

    it('supports freeform questions with no options by submitting typed answers', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeFreeformTool());
        const input = screen.findByProps({ testID: 'ask-user-question.freeform:0' });
        const stopPropagation = vi.fn();
        input.props.onTouchStart?.({ stopPropagation });
        expect(stopPropagation).toHaveBeenCalledTimes(1);

        await fillFreeformAndSubmit(screen, 'README.md');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: { 'Which file should I inspect?': ['README.md'] } });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });

    it('moves the only interactive form and its held text between mounted copies of the same request', async () => {
        const form = makeToolViewProps(makeFreeformTool(), { sessionId: 's1' });
        let showCopy: React.Dispatch<React.SetStateAction<boolean>> = () => {};
        function Copies() {
            const [open, setOpen] = React.useState(false);
            showCopy = setOpen;
            return React.createElement(React.Fragment, null,
                React.createElement(AskUserQuestionView, { ...form, key: 'initial' }),
                open ? React.createElement(AskUserQuestionView, { ...form, key: 'added' }) : null);
        }
        const screen = await renderScreen(React.createElement(Copies));
        const editable = () => screen.findAll(node =>
            node.props.testID === 'ask-user-question.freeform:0' && node.props.editable === true
            && typeof node.props.onChangeText === 'function' && typeof node.type === 'string');
        expect(editable()).toHaveLength(1);
        await act(async () => changeTextTestInstance(editable()[0], 'A held answer', 'initial answer'));
        await act(async () => showCopy(true));
        expect(editable()).toHaveLength(1);
        expect(editable()[0]?.props.value).toBe('A held answer');
        await act(async () => showCopy(false));
        expect(editable()).toHaveLength(1);
        expect(editable()[0]?.props.value).toBe('A held answer');
    });

    it('keeps a stale answer as recoverable text without filling the replacement question', async () => {
        const form = makeToolViewProps(makeFreeformTool(), { sessionId: 's1' });
        activeAskUserQuestionRequest = { tool: 'AskUserQuestion', kind: 'user_action', turnId: 'old-turn' };
        let replace: React.Dispatch<React.SetStateAction<boolean>> = () => {};
        function ReplaceableQuestion() {
            const [replaced, setReplaced] = React.useState(false);
            replace = setReplaced;
            return React.createElement(AskUserQuestionView, replaced ? { ...form, tool: { ...form.tool } } : form);
        }
        const screen = await renderScreen(React.createElement(ReplaceableQuestion));
        const input = () => screen.findByProps({ testID: 'ask-user-question.freeform:0' });
        await act(async () => { changeTextTestInstance(input(), 'unsent original', 'original question'); });
        const submitOriginal = screen.findByProps({ testID: 'ask-user-question.submit' }).props.onPress;
        activeAskUserQuestionRequest = { tool: 'AskUserQuestion', kind: 'user_action', turnId: 'new-turn' };
        await act(async () => { replace(true); });
        await act(async () => { submitOriginal(); });
        expect(sessionAllowWithAnswers).not.toHaveBeenCalled();
        expect(input().props.value).toBe('');
        expect(screen.getTextContent()).toContain('unsent original');
    });

    it('sends two held answers through their individual turn-qualified actions and reports each result', async () => {
        const pending = (turnId: string) => ({ tool: 'AskUserQuestion', kind: 'user_action', turnId, createdAt: 1, arguments: {} });
        askUserQuestionSessionState.current = { agentState: { requests: { toolu_1: pending('turn-1'), toolu_2: pending('turn-2') } } };
        sessionAllowWithAnswers.mockImplementation(async ({ id }) => {
            if (id === 'toolu_2') throw new Error('Second answer refused');
        });
        const first = makeFreeformTool();
        const second = makeFreeformTool({ id: 'toolu_2', permission: { id: 'toolu_2', status: 'pending' } });
        const screen = await renderScreen(React.createElement(QuestionSendGroup, null,
            React.createElement(AskUserQuestionView, makeToolViewProps(first, { sessionId: 's1' })),
            React.createElement(AskUserQuestionView, makeToolViewProps(second, { sessionId: 's1' }))));
        const fields = screen.findAll(node => node.props.testID === 'ask-user-question.freeform:0' && typeof node.type === 'string');
        expect(fields).toHaveLength(2);
        await act(async () => {
            changeTextTestInstance(fields[0], 'first draft', 'first question');
            changeTextTestInstance(fields[1], 'second draft', 'second question');
        });
        await screen.pressByTestIdAsync('question-group-send');
        expect(sessionAllowWithAnswers.mock.calls.map(([response]) => response)).toEqual([
            { id: 'toolu_1', turnId: 'turn-1', answers: { 'Which file should I inspect?': ['first draft'] } },
            { id: 'toolu_2', turnId: 'turn-2', answers: { 'Which file should I inspect?': ['second draft'] } },
        ]);
        expect(screen.getTextContent()).toContain('sessionWork.questions.sent');
        expect(screen.getTextContent()).toContain('Second answer refused');
        expect(screen.findByProps({ testID: 'ask-user-question.freeform:0' }).props.value).toBe('second draft');
    });

    it('supports suggestion questions that allow a typed freeform answer (options + freeform)', async () => {
        sessionAllowWithAnswers.mockResolvedValueOnce(undefined);

        const screen = await renderView(makeSuggestionsWithFreeformTool());

        const submitBefore = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submitBefore).toBeTruthy();
        expect(submitBefore!.props.disabled).toBe(true);

        const input = screen.findByProps({ testID: 'ask-user-question.freeform:0' });
        await act(async () => {
            changeTextTestInstance(input, 'Custom goal, with commas', 'ask-user-question freeform input');
        });

        const submitAfter = findPressableByLabel(screen, 'tools.askUserQuestion.submit');
        expect(submitAfter).toBeTruthy();
        expect(submitAfter!.props.disabled).toBe(false);

        await pressTestInstanceAsync(submitAfter, 'tools.askUserQuestion.submit');

        expect(sessionAllowWithAnswers).toHaveBeenCalledTimes(1);
        expect(sessionAllowWithAnswers).toHaveBeenCalledWith({ id: 'toolu_1', answers: { 'What are you trying to achieve?': ['Custom goal, with commas'] } });
        expect(sessionDeny).toHaveBeenCalledTimes(0);
        expect(sendMessage).toHaveBeenCalledTimes(0);
    });
});
