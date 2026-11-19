import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { View } from 'react-native';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { AutomationDefinitionDetailsRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

// HTTP, credentials, native rendering and Metro loading are external boundaries.
// Account currentness, the Action front door, trigger reads and rendering stay real.
installDisconnectedServerSocketBoundary();
// Runtime consumers load after the boundary so they bind the disconnected socket.
const { AccountTriggersSection } = await import('./AccountTriggersSection');
const { ScheduledWorkflowSection } = await import('./ScheduledWorkflowSection');
const { SubjectTriggersSection, SubjectTriggersSectionContent } = await import('./SubjectTriggersSection');
const { useResourceAutomationsSection } = await import('./useResourceAutomationsSection');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});


const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json' },
});
/** The Home's plain-Account HTTP answers; only the Automation read is supplied by the caller. */
function homeRequest(automations: (url: URL, init?: RequestInit) => Promise<Response>) {
    return async (url: unknown, init?: RequestInit) => {
        const requestUrl = new URL(String(url));
        const path = requestUrl.pathname;
        if (path === '/health') return json({});
        if (path === '/v1/features' || path === '/v1/features/authenticated') {
            const features = createRootLayoutFeaturesResponse();
            return json({ ...features, capabilities: { ...features.capabilities,
                accountStoredContentCompatibility: { v: 1,
                    minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    declarationTransport: 'http-header-and-socket-auth-v1' },
            } });
        }
        if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return json({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
        if (path === '/v2/account/settings') return json({ content: null, version: 0 });
        if (path === '/v1/artifacts') return json([]);
        if (path === '/v3/automations' || path === '/v3/automations/query') return automations(requestUrl, init);
        return json({ error: 'route_not_found' }, 404);
    };
}

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of disposals.splice(0).reverse()) await dispose();
    vi.restoreAllMocks();
});

describe('Account trigger HTTP read failure and recovery', () => {
    it('keeps a conditional Builder editable through its branch selections and full-editor handoff', async () => {
        await loadSyncSingletonForTests();
        const account = await restoreServerAccountForTest({
            serverUrl: `https://conditional-sentence-${crypto.randomUUID()}.test`, accountId: 'conditional-sentence',
            request: homeRequest(async () => json({ automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0 })),
        });
        disposals.push(() => account.dispose());
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { WorkflowSentenceBuilder } = await import('../sentence/WorkflowSentenceBuilder');
        const { WorkflowDefinitionV1Schema } = await import('@happier-dev/protocol/workflows/workflowV1');
        const { readWorkflowDefinitionDraftSeed } = await import('@/sync/domains/workflows/workflowDefinitionDraftSeed');
        const { ScopedAuthoringComposer } = await import('@/components/sessions/authoring/ScopedAuthoringComposer');
        const { AgentInput } = await import('@/components/sessions/agentInput');
        const { readComposerPresentationSnapshot } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
        const { router } = await import('expo-router');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (lifetime === null) throw new Error('Expected the Builder Account lifetime');
        const command = (id: string) => ({ kind: 'action', id, actionId: 'machines.command.run', input: {
            machineId: { kind: 'literal', value: 'machine-a' }, command: { kind: 'literal', value: `echo ${id}` },
        } });
        const definition = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{
            kind: 'if', id: 'gate', when: { kind: 'exists', value: { kind: 'input', name: 'goal' } },
            then: [{ kind: 'step', id: 'deep', document: { text: 'Review the change', references: [], attachments: [] },
                input: [], result: { kind: 'text' } }], otherwise: [command('quick')],
        }], inputs: [{ name: 'goal', valueType: 'string', required: true }] });
        const restorePopoverGlobals = withPopoverWebGlobals();
        disposals.unshift(async () => restorePopoverGlobals());
        const screen = await renderScreen(<WorkflowSentenceBuilder anchorRef={React.createRef<View>()}
            intent={{ name: 'Review changes', definition }} accountLifetime={lifetime} onRequestClose={() => {}} />, {
            // Test Renderer supplies host geometry and DOM events used by the real dropdown and step card.
            createNodeMock: element => element.type === 'View' ? {
                addEventListener() {},
                removeEventListener() {},
                measureInWindow: callback => callback(0, 0, 300, 40),
            } satisfies Pick<View, 'measureInWindow'> & Pick<EventTarget, 'addEventListener' | 'removeEventListener'> : null,
        });
        disposals.push(() => screen.unmount());
        await flushHookEffects();
        expect(screen.findHostByTestId('workflow-builder')).not.toBeNull();
        await screen.pressByTestIdAsync('workflow-builder-sentence-if:gate');
        await screen.pressByTestIdAsync('workflow-builder-if-gate-summary');
        await screen.pressByTestIdAsync('workflow-builder-inspector-condition-test-trigger');
        await vi.waitFor(() => expect(screen.findByTestId('workflow-builder-inspector-condition-test-not_exists')).not.toBeNull());
        await screen.pressByTestIdAsync('workflow-builder-inspector-condition-test-not_exists');
        await screen.pressByTestIdAsync('workflow-builder-inspector-done');
        for (const id of ['deep', 'quick']) {
            expect(screen.findHostByTestId(`workflow-builder-sentence-step:${id}`)).not.toBeNull();
            await screen.pressByTestIdAsync(`workflow-builder-sentence-step:${id}`);
            await flushHookEffects();
            expect(screen.findHostByTestId(`workflow-builder-sentence-step:${id}`)?.props.accessibilityState?.selected).toBe(true);
            const other = id === 'deep' ? 'quick' : 'deep';
            expect(screen.findHostByTestId(`workflow-builder-sentence-step:${other}`)?.props.accessibilityState?.selected).toBe(false);
        }
        await screen.pressByTestIdAsync('workflow-builder-sentence-step:deep');
        const composer = screen.findByType(ScopedAuthoringComposer);
        const composerRef = (composer.props as React.ComponentProps<typeof ScopedAuthoringComposer>).custody.ref;
        expect(readComposerPresentationSnapshot(composerRef)?.text).toBe('Review the change');
        const editedText = 'Review the change carefully';
        const caret = { start: 7, end: 10 };
        await act(async () => {
            const input = screen.findByType(AgentInput);
            input.props.onChangeText(editedText);
            input.props.inputPersistence.onSelectionChangePersist(caret, editedText.length);
        });
        expect(readComposerPresentationSnapshot(composerRef)).toMatchObject({ text: editedText, selection: caret });
        await screen.pressByTestIdAsync('workflow-builder-sentence-step:quick');
        await screen.pressByTestIdAsync('workflow-builder-sentence-step:deep');
        expect(readComposerPresentationSnapshot(composerRef)).toMatchObject({ text: editedText, selection: caret });
        expect(screen.findByType(AgentInput).props.value).toBe(editedText);
        await screen.pressByTestIdAsync('workflow-builder-open-editor');
        const entry = vi.mocked(router.push).mock.calls.at(-1)?.[0];
        if (typeof entry !== 'object' || entry === null || !('params' in entry)) throw new Error('Expected the editor handoff');
        const editedBlocks = readWorkflowDefinitionDraftSeed(String(entry.params?.definitionDraftSeedId), lifetime.scope)?.draft?.blocks;
        expect(editedBlocks).toMatchObject([{
            kind: 'if', id: 'gate',
            when: { kind: 'not', condition: { kind: 'exists', value: { kind: 'input', name: 'goal' } } },
            then: [{ kind: 'step', id: 'deep', document: { text: editedText, references: [], attachments: [] } }],
            otherwise: [command('quick')],
        }]);
    });

    it('opens subject starters in place and retains their draft in the full editor without enrolling a trigger', async () => {
        await loadSyncSingletonForTests();
        let writes = 0;
        const account = await restoreServerAccountForTest({
            serverUrl: `https://subject-sentence-${crypto.randomUUID()}.test`, accountId: 'subject-sentence',
            request: homeRequest(async (_url, init) => {
                if (init?.method !== undefined && init.method !== 'GET' && !String(_url).includes('/query')) writes++;
                return json({ automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0 });
            }),
        });
        disposals.push(() => account.dispose());
        const { router } = await import('expo-router');
        const { readWorkflowDefinitionDraftSeed } = await import('@/sync/domains/workflows/workflowDefinitionDraftSeed');
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active>
            <ListPresentationProvider value="page">
            <SubjectTriggersSection subject={{ kind: 'service', machineId: 'machine-a', serviceId: 'web' }} subjectName="Web" />
            </ListPresentationProvider>
        </PluginSurfaceFocusEligibilityProvider>);
        disposals.push(() => screen.unmount());
        await waitForHomeGovernance(() => expect(screen.findByTestId('subject-triggers-add'), screen.getTextContent()).toBeTruthy());
        const restorePopoverGlobals = withPopoverWebGlobals();
        disposals.unshift(async () => restorePopoverGlobals());
        for (const id of ['subject-triggers-add', 'subject-triggers-starter:healthFailed', 'subject-triggers-starter:nightly']) {
            const before = vi.mocked(router.push).mock.calls.length;
            await act(async () => screen.findByTestId(id)!.props.onPress());
            expect(screen.findByTestId('workflow-builder'), screen.getTextContent()).toBeTruthy();
            expect(vi.mocked(router.push).mock.calls).toHaveLength(before);
            expect(writes).toBe(0);
            await act(async () => screen.findByTestId('workflow-builder-open-editor')!.props.onPress());
            expect(vi.mocked(router.push).mock.calls).toHaveLength(before + 1);
            const entry = vi.mocked(router.push).mock.calls.at(-1)?.[0];
            if (typeof entry !== 'object' || entry === null || !('params' in entry)) throw new Error('Expected a sentence route');
            const seed = readWorkflowDefinitionDraftSeed(String(entry.params?.definitionDraftSeedId));
            expect(seed).toMatchObject({ name: 'Web', initialView: 'sentence', project: { machineId: 'machine-a', directory: '~' } });
            expect(seed?.definition).toBeUndefined();
            if (id.endsWith('healthFailed')) expect(seed?.incompleteTriggers?.pending).toEqual([
                expect.objectContaining({ eventSeed: expect.objectContaining({ setupInput: expect.objectContaining({
                    subject: { kind: 'machineService', machineId: 'machine-a', serviceId: 'web' },
                }) }) }),
            ]);
            if (id.endsWith('nightly')) expect(seed?.triggers?.rows).toEqual([
                expect.objectContaining({ trigger: expect.objectContaining({ kind: 'schedule', schedule: expect.objectContaining({ scheduleExpr: '0 3 * * *' }) }) }),
            ]);
        }
        expect(writes).toBe(0);
    });
    it('Session attachment reads follow the layout presentation owner', async () => {
        await loadSyncSingletonForTests();
        let reads = 0;
        const accountDetailsQuery = JSON.stringify(AutomationDefinitionDetailsRequestSchema.parse({ details: true }));
        const account = await restoreServerAccountForTest({
            serverUrl: `https://session-trigger-demand-${crypto.randomUUID()}.test`,
            serverIdentityId: 'srv_session-trigger-demand', accountId: 'session-trigger-demand',
            request: homeRequest(async (url, init) => {
                if (url.pathname === '/v3/automations/query') {
                    const query = AutomationDefinitionDetailsRequestSchema.safeParse(JSON.parse(String(init?.body)));
                    if (query.success && JSON.stringify(query.data) === accountDetailsQuery) reads++;
                }
                return json({ automations: [], nextCursor: null });
            }),
        });
        disposals.push(() => account.dispose());
        const sessionSection = { subject: { kind: 'session' as const, serverId: 'srv_session-trigger-demand', sessionId: 'demand-session' } };
        function SessionAttachmentRead() {
            useResourceAutomationsSection(sessionSection);
            return null;
        }
        const content = (presented: boolean) => <PluginSurfaceFocusEligibilityProvider active={presented}>
            <SessionAttachmentRead />
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(content(false));
        await flushHookEffects();
        expect(reads).toBe(0);
        await act(async () => screen.update(content(true)));
        await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
        await screen.unmount();
    });
    it('resource attachment reads follow the layout presentation owner without an active prop', async () => {
        await loadSyncSingletonForTests();
        let reads = 0;
        const account = await restoreServerAccountForTest({
            serverUrl: `https://subject-trigger-demand-${crypto.randomUUID()}.test`,
            accountId: 'subject-trigger-demand',
            request: homeRequest(async (url, init) => {
                // Bootstrap's managed-target migration shares this endpoint; only the
                // selected-subject query belongs to the mounted section.
                if (url.pathname === '/v3/automations/query'
                    && 'subject' in JSON.parse(String(init?.body))) reads++;
                return json({ automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0 });
            }),
        });
        disposals.push(() => account.dispose());
        const subject = { kind: 'machine' as const, machineId: 'demand-machine' };
        const content = (presented: boolean) => <PluginSurfaceFocusEligibilityProvider active={presented}>
            <SubjectTriggersSection subject={subject} subjectName="Demand Machine" />
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(content(false));
        await flushHookEffects();
        expect(reads).toBe(0);
        await act(async () => screen.update(content(true)));
        await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
        await screen.unmount();
    });
    it.each([
        { surface: 'triggers', failure: 'offline', Component: AccountTriggersSection, readId: 'account-triggers-read', retryId: 'account-triggers-read-retry', sectionId: 'workflows-column:group:triggers' },
        { surface: 'triggers', failure: 'unavailable', Component: AccountTriggersSection, readId: 'account-triggers-read', retryId: 'account-triggers-read-retry', sectionId: 'workflows-column:group:triggers' },
        { surface: 'scheduled', failure: 'offline', Component: ScheduledWorkflowSection, readId: 'scheduled-workflow-read', retryId: 'scheduled-workflow-read-action', sectionId: 'workflows-column:group:scheduled' },
        { surface: 'scheduled', failure: 'unavailable', Component: ScheduledWorkflowSection, readId: 'scheduled-workflow-read', retryId: 'scheduled-workflow-read-action', sectionId: 'workflows-column:group:scheduled' },
    ] as const)('keeps $surface visible after a $failure remount and retries through its Account owner', async ({ failure, Component, readId, retryId, sectionId }) => {
        await loadSyncSingletonForTests();
        const { storage } = await import('@/sync/domains/state/storageStore');
        let fail = false;
        let gate = createDeferred<void>();
        let reads = 0;
        const account = await restoreServerAccountForTest({
            serverUrl: `https://account-trigger-read-${crypto.randomUUID()}.test`,
            accountId: 'account-trigger-read',
            request: homeRequest(async () => {
                // Only this Account read fails; readiness keeps its own HTTP contract.
                reads++;
                await gate.promise;
                if (fail && failure === 'offline') throw new TypeError('Failed to fetch');
                return fail ? json({ error: 'temporarily_unavailable' }, 503)
                    : json({ automations: [], nextCursor: null });
            }),
        });
        disposals.push(() => account.dispose());
        // Establish an empty successful observation before the offline remount,
        // matching the browser's previously hidden empty Account section.
        const initial = await renderScreen(<Component />);
        await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
        // Empty secondary sections reserve no body while their first read is pending.
        expect(initial.findByTestId(readId)).toBeNull();
        expect(initial.findByTestId(sectionId)).toBeNull();
        await act(async () => gate.resolve());
        await vi.waitFor(() => expect(storage.getState().workflowTriggerSetIdsByQuery[
            Component === AccountTriggersSection ? 'account_inline' : 'account_all'
        ]).toEqual([]));
        await vi.waitFor(() => expect(initial.findByTestId(readId)).toBeNull());
        await initial.unmount();

        fail = true;
        gate = createDeferred<void>();
        const beforeRemount = reads;
        const screen = await renderScreen(<Component />);
        await vi.waitFor(() => expect(reads).toBeGreaterThan(beforeRemount));
        expect(screen.findByTestId(readId)).toBeNull();
        await act(async () => gate.resolve());
        await vi.waitFor(() => expect(screen.findByTestId(retryId)).not.toBeNull());
        expect(screen.getTextContent()).toContain('workflows.triggers.section.accountLoadFailed');
        expect(screen.findByTestId(sectionId)).not.toBeNull();

        fail = false;
        const beforeRetry = reads;
        await screen.pressByTestIdAsync(retryId);
        await vi.waitFor(() => expect(reads).toBeGreaterThan(beforeRetry));
        await flushHookEffects();
        await vi.waitFor(() => expect(screen.findByTestId(readId)).toBeNull());
        expect(screen.findByTestId(sectionId)).toBeNull();
        await screen.unmount();
    });
});

describe('Resource Automations section read states', () => {
    it.each(['work-add', 'exact-turn', 'hook-work-add'] as const)('opens %s through the shared Session sentence and retains its typed intake in the full editor', async (source) => {
        await loadSyncSingletonForTests();
        const account = await restoreServerAccountForTest({
            serverUrl: `https://shared-session-entry-${crypto.randomUUID()}.test`,
            serverIdentityId: 'srv_shared-session-home', accountId: 'shared-session-entry',
            request: homeRequest(async () => json({ automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0 })),
        });
        disposals.push(() => account.dispose());
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { readWorkflowDefinitionDraftSeed } = await import('@/sync/domains/workflows/workflowDefinitionDraftSeed');
        const { router } = await import('expo-router');
        const lifetime = captureActiveServerAccountScopeLifetime();
        const subject = { kind: 'session' as const, serverId: 'srv_shared-session-home', sessionId: 'shared-session' };
        const actionsRef = React.createRef<{ openNewTrigger(anchor: React.RefObject<View | null>): void }>();
        const anchor = React.createRef<View>();
        const exactTurnPrefill = source === 'exact-turn' ? { sourceSessionId: subject.sessionId,
            sourceServerId: subject.serverId, sourceTurnId: 'observed-turn', events: ['parentTurnCompleted'] as const } : undefined;
        const restorePopoverGlobals = withPopoverWebGlobals();
        disposals.unshift(async () => restorePopoverGlobals());
        const sectionProps = { subject, subjectName: 'Shared Session', accountLifetime: lifetime, actionsRef, exactTurnPrefill };
        function MountedSessionIntake() {
            const automations = useResourceAutomationsSection(sectionProps);
            return <SubjectTriggersSectionContent {...sectionProps} automations={automations} />;
        }
        const content = () => <PluginSurfaceFocusEligibilityProvider active>
            <ListPresentationProvider value="page">
                {source === 'work-add' ? <SubjectTriggersSection {...sectionProps} /> : <MountedSessionIntake />}
            </ListPresentationProvider>
        </PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(content());
        disposals.push(() => screen.unmount());
        if (source !== 'exact-turn') {
            expect(actionsRef.current).not.toBeNull();
            await act(async () => actionsRef.current!.openNewTrigger(anchor));
        }
        await waitForHomeGovernance(() => expect(screen.findByTestId('workflow-builder'), screen.getTextContent()).not.toBeNull());
        await screen.pressByTestIdAsync('workflow-builder-open-editor');
        const entry = vi.mocked(router.push).mock.calls.at(-1)?.[0];
        if (typeof entry !== 'object' || entry === null || !('params' in entry)) throw new Error('Expected shared sentence editor route');
        const seed = readWorkflowDefinitionDraftSeed(String(entry.params?.definitionDraftSeedId));
        expect(seed).toMatchObject({ lifetimeSession: { sessionId: subject.sessionId },
            startContext: { session: { subject } }, triggers: { rows: [expect.objectContaining({ trigger: expect.objectContaining({
                kind: 'sessionLifecycle', subject,
                policy: source === 'exact-turn' ? { kind: 'currentTurn', sourceTurnId: 'observed-turn' } : { kind: 'everyMatch' },
            }) })] } });
        if (source === 'exact-turn') {
            await act(async () => screen.update(content()));
            expect(screen.findByTestId('workflow-builder')).toBeNull();
        }
    });

    it('keeps its place while the first read is pending and offers Retry in place when it fails', async () => {
        await loadSyncSingletonForTests();
        let fail = true;
        let gate = createDeferred<void>();
        let reads = 0;
        const account = await restoreServerAccountForTest({
            serverUrl: `https://subject-trigger-states-${crypto.randomUUID()}.test`,
            accountId: 'subject-trigger-states',
            request: homeRequest(async (url, init) => {
                if (url.pathname === '/v3/automations/query' && 'subject' in JSON.parse(String(init?.body))) {
                    reads++;
                    await gate.promise;
                    if (fail) return json({ error: 'temporarily_unavailable' }, 503);
                    return json({ automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0 });
                }
                return json({ automations: [], nextCursor: null });
            }),
        });
        disposals.push(() => account.dispose());
        const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active>
            <ListPresentationProvider value="page">
                <SubjectTriggersSection subject={{ kind: 'machine', machineId: 'machine-states' }} subjectName="Studio" />
            </ListPresentationProvider>
        </PluginSurfaceFocusEligibilityProvider>);
        disposals.push(() => screen.unmount());
        await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
        // Pending: the section is already there, holding placeholder rows rather than appearing later.
        expect(screen.findByTestId('subject-triggers')).not.toBeNull();
        expect(screen.findByTestId('subject-triggers-read')).not.toBeNull();
        expect(screen.findByTestId('subject-triggers-read-retry')).toBeNull();
        await act(async () => gate.resolve());
        await vi.waitFor(() => expect(screen.findByTestId('subject-triggers-read-retry')).not.toBeNull());
        expect(screen.getTextContent()).toContain('workflows.triggers.section.automationsLoadFailed');
        expect(screen.findByTestId('subject-triggers-starter:nightly')).toBeNull();

        fail = false;
        gate = createDeferred<void>();
        gate.resolve();
        const beforeRetry = reads;
        await screen.pressByTestIdAsync('subject-triggers-read-retry');
        await vi.waitFor(() => expect(reads).toBeGreaterThan(beforeRetry));
        await vi.waitFor(() => expect(screen.findByTestId('subject-triggers-starter:nightly')).not.toBeNull());
        expect(screen.findByTestId('subject-triggers-read')).toBeNull();
    });
});

describe('Account triggers while the Account is still being established', () => {
    it('read as loading rather than failed until the Account arrives, then settle without a retry', async () => {
        await loadSyncSingletonForTests();
        // Right after sign-in the app mounts before any Account scope exists: nothing has failed yet.
        const screen = await renderScreen(<AccountTriggersSection first />);
        expect(screen.findByTestId('account-triggers-read')).not.toBeNull();
        expect(screen.findByTestId('account-triggers-read-retry')).toBeNull();
        expect(screen.getTextContent()).not.toContain('workflows.triggers.section.accountLoadFailed');

        const account = await restoreServerAccountForTest({
            serverUrl: `https://account-trigger-hydrating-${crypto.randomUUID()}.test`,
            accountId: 'account-trigger-hydrating',
            request: homeRequest(async () => json({ automations: [], nextCursor: null })),
        });
        disposals.push(() => account.dispose());
        await vi.waitFor(() => expect(screen.findByTestId('account-triggers-read')).toBeNull());
        expect(screen.getTextContent()).not.toContain('workflows.triggers.section.accountLoadFailed');
        await screen.unmount();
    });
});

describe('Account triggers while the Home reconnects', () => {
    it('keeps a settled read failure actionable while reconnecting and retries once the Home answers', async () => {
        await loadSyncSingletonForTests();
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        let reads = 0;
        const account = await restoreServerAccountForTest({
            serverUrl: `https://account-trigger-connecting-${crypto.randomUUID()}.test`,
            accountId: 'account-trigger-connecting',
            request: homeRequest(async () => { reads++; return json({ error: 'temporarily_unavailable' }, 503); }),
        });
        disposals.push(() => account.dispose());
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        disposals.push(async () => { publishAppliedActiveServerRuntimeAvailability(false); });
        const screen = await renderScreen(<AccountTriggersSection first />);
        // The Home is unreachable and the read fails: that is a settled failure with its retry.
        await vi.waitFor(() => expect(screen.findByTestId('account-triggers-read-retry')).not.toBeNull());

        // Reconnecting does not erase an already-settled failure or its recovery control.
        // The owner-level trigger-read suite covers the same retained-failure contract.
        await act(async () => storage.setState({ endpointStatus: 'connecting', socketStatus: 'connecting' }));
        expect(screen.findByTestId('account-triggers-read-retry')).not.toBeNull();
        expect(screen.getTextContent()).toContain('workflows.triggers.section.accountLoadFailed');

        // Once the Home has answered the read is made again, and a failure that persists is reported.
        const beforeSettled = reads;
        await act(async () => storage.setState({ endpointStatus: 'online', socketStatus: 'connected' }));
        await vi.waitFor(() => expect(screen.findByTestId('account-triggers-read-retry')).not.toBeNull());
        expect(reads).toBeGreaterThan(beforeSettled);
        await screen.unmount();
    });
});
