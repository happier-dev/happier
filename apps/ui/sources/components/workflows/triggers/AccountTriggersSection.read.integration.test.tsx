import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { createDeferred, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { AccountTriggersSection } from './AccountTriggersSection';
import { ScheduledWorkflowSection } from './ScheduledWorkflowSection';

// HTTP, credentials, native rendering and Metro loading are external boundaries.
// Account currentness, the Action front door, trigger reads and rendering stay real.
installDisconnectedServerSocketBoundary();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

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
        const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
            status, headers: { 'Content-Type': 'application/json' },
        });
        let fail = false;
        let gate = createDeferred<void>();
        let reads = 0;
        const account = await restoreServerAccountForTest({
            serverUrl: `https://account-trigger-read-${crypto.randomUUID()}.test`,
            accountId: 'account-trigger-read',
            request: async (url) => {
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
                if (path === '/v3/automations') {
                    // Only this Account read fails; readiness keeps its own HTTP contract.
                    reads++;
                    await gate.promise;
                    if (fail && failure === 'offline') throw new TypeError('Failed to fetch');
                    return fail ? json({ error: 'temporarily_unavailable' }, 503)
                        : json({ automations: [], nextCursor: null });
                }
                return json({ error: 'route_not_found' }, 404);
            },
        });
        disposals.push(() => account.dispose());
        // Establish an empty successful observation before the offline remount,
        // matching the browser's previously hidden empty Account section.
        const initial = await renderScreen(<Component />);
        await vi.waitFor(() => expect(initial.findByTestId(readId)).not.toBeNull());
        await act(async () => gate.resolve());
        await vi.waitFor(() => expect(initial.findByTestId(readId)).toBeNull());
        await initial.unmount();

        fail = true;
        gate = createDeferred<void>();
        const screen = await renderScreen(<Component />);
        await vi.waitFor(() => expect(screen.findByTestId(readId)).not.toBeNull());
        await act(async () => gate.resolve());
        await vi.waitFor(() => expect(screen.findByTestId(retryId)).not.toBeNull());
        expect(screen.getTextContent()).toContain('workflows.triggers.section.accountLoadFailed');
        expect(screen.findByTestId(sectionId)).not.toBeNull();

        fail = false;
        const beforeRetry = reads;
        await screen.pressByTestIdAsync(retryId);
        await vi.waitFor(() => expect(screen.findByTestId(readId)).toBeNull());
        expect(reads).toBeGreaterThan(beforeRetry);
        expect(screen.findByTestId(sectionId)).toBeNull();
        await screen.unmount();
    });
});
