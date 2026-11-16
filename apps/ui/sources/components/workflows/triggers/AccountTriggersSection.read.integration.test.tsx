import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
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
const { SubjectTriggersSection } = await import('./SubjectTriggersSection');
const { useSessionTriggers } = await import('./useSessionTriggers');
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
    it('opens subject custom and Event starters in the ordinary sentence editor without enrolling a trigger', async () => {
        await loadSyncSingletonForTests();
        let writes = 0;
        const account = await restoreServerAccountForTest({
            serverUrl: `https://subject-sentence-${crypto.randomUUID()}.test`, accountId: 'subject-sentence',
            request: homeRequest(async (_url, init) => {
                if (init?.method !== undefined && init.method !== 'GET' && !String(_url).includes('/query')) writes++;
                return json({ automations: [], nextCursor: null });
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
        for (const id of ['subject-triggers-add', 'subject-triggers-set-up', 'subject-triggers-starter:healthFailed', 'subject-triggers-starter:nightly']) {
            const before = vi.mocked(router.push).mock.calls.length;
            await act(async () => screen.findByTestId(id)!.props.onPress());
            expect(vi.mocked(router.push).mock.calls).toHaveLength(before + 1);
            const entry = vi.mocked(router.push).mock.calls.at(-1)?.[0];
            if (typeof entry !== 'object' || entry === null || !('params' in entry)) throw new Error('Expected a sentence route');
            const seed = readWorkflowDefinitionDraftSeed(String(entry.params?.definitionDraftSeedId));
            expect(seed).toMatchObject({ name: 'Web', initialView: 'sentence', project: { machineId: 'machine-a', directory: '~' } });
            expect(seed?.definition).toBeUndefined();
            if (id.endsWith('healthFailed')) expect(seed?.eventSeed?.setupInput).toMatchObject({ subject: { kind: 'machineService', machineId: 'machine-a', serviceId: 'web' } });
            if (id.endsWith('nightly')) expect(seed?.trigger).toMatchObject({ kind: 'schedule', schedule: { scheduleExpr: '0 3 * * *' } });
        }
        expect(writes).toBe(0);
    });
    it('Session attachment reads follow the layout presentation owner', async () => {
        await loadSyncSingletonForTests();
        let reads = 0;
        const accountDetailsQuery = JSON.stringify(AutomationDefinitionDetailsRequestSchema.parse({ details: true }));
        const account = await restoreServerAccountForTest({
            serverUrl: `https://session-trigger-demand-${crypto.randomUUID()}.test`,
            accountId: 'session-trigger-demand',
            request: homeRequest(async (url, init) => {
                if (url.pathname === '/v3/automations/query') {
                    const query = AutomationDefinitionDetailsRequestSchema.safeParse(JSON.parse(String(init?.body)));
                    if (query.success && JSON.stringify(query.data) === accountDetailsQuery) reads++;
                }
                return json({ automations: [], nextCursor: null });
            }),
        });
        disposals.push(() => account.dispose());
        function SessionAttachmentRead() {
            useSessionTriggers('demand-session');
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
                // Account-inline detail query belongs to the mounted section.
                if (url.pathname === '/v3/automations/query'
                    && JSON.parse(String(init?.body)).scope === 'account_inline') reads++;
                return json({ automations: [], nextCursor: null });
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
