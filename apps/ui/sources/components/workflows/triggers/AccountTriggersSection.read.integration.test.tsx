import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// HTTP, credentials, native rendering and Metro loading are external boundaries.
// Account currentness, the Action front door, trigger reads and rendering stay real.
installDisconnectedServerSocketBoundary();
// Runtime consumers load after the boundary so they bind the disconnected socket.
const { AccountTriggersSection } = await import('./AccountTriggersSection');
const { ScheduledWorkflowSection } = await import('./ScheduledWorkflowSection');
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
function homeRequest(automations: () => Promise<Response>) {
    return async (url: unknown) => {
        const path = new URL(String(url)).pathname;
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
        if (path === '/v3/automations' || path === '/v3/automations/query') return automations();
        return json({ error: 'route_not_found' }, 404);
    };
}

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of disposals.splice(0).reverse()) await dispose();
    vi.restoreAllMocks();
});

describe('Account trigger HTTP read failure and recovery', () => {
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
