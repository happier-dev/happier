import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';
import type { IModal } from '@/modal';

import { createManagedResourceDependencyFixture } from '@/dev/testkit/fixtures/managedResourceDependencyFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installApprovalCommonModuleMocks();
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
afterEach(async () => { await connection?.dispose(); connection = null; });

describe('Account plugin erase native resource review at the real Action and HTTP owners', () => {
    it.each(['cancel', 'manual', 'retired'] as const)('keeps native custody until review is explicitly accepted (%s)', async (choice) => {
        const resource = createManagedResourceDependencyFixture();
        const path = '/v1/plugins/data/account-erase';
        const requests: unknown[] = [];
        const settingsWrites: unknown[] = [];
        const settings = { actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, approvalWaivedSurfaces: { 'account.plugins.data.erase': ['ui'] },
        }) };
        connection = await restoreServerAccountForTest({ serverUrl: 'https://plugin-native-review.test',
            serverIdentityId: 'srv_plugin_native_review', accountId: 'account-owner',
            credentials: { token: createAccountTokenForTests('account-owner', { currentAccount: true }) },
            request: async (rawUrl, init) => {
                const url = new URL(String(rawUrl));
                if (url.pathname === '/health') return Response.json({});
                if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
                    capabilities: { serverIdentity: { serverIdentityId: 'srv_plugin_native_review' } },
                }));
                if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }));
                if (url.pathname === '/v2/account/settings') {
                    if (init?.method === 'POST') settingsWrites.push(JSON.parse(String(init.body)));
                    return Response.json({ content: { t: 'plain', v: settings }, version: 1 });
                }
                if (url.pathname === '/v1/artifacts') return Response.json([]);
                if (url.pathname === path) {
                    const input: unknown = JSON.parse(String(init?.body));
                    requests.push(input);
                    return input && typeof input === 'object' && 'managedResourceDispositions' in input
                        ? Response.json({ status: 'transition-cleanup-pending' })
                        : Response.json({ error: 'managed_resources_review_required', resources: [resource] }, { status: 409 });
                }
                return Response.json({ error: 'not_found' }, { status: 404 });
            },
        });
        const { storage } = await import('@/sync/domains/state/storage');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverProfiles');
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'account-owner' };
        storage.getState().activateProfileScope(scope);
        await storage.getState().activateSettingsScope(scope);
        storage.getState().applySettings({ ...storage.getState().settings, ...settings }, 1);
        const modal = { prompt: vi.fn<IModal['prompt']>(async () => null), alert: vi.fn<IModal['alert']>(),
            confirm: vi.fn<IModal['confirm']>(async () => true) };
        modal.confirm.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
            if (choice === 'retired') storage.getState().activateProfileScope({ ...scope, accountId: 'account-next' });
            return choice !== 'cancel';
        });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { createPluginAccountDataEraseRecoveryController } = await import('./pluginAccountDataEraseRecoveryController');
        const executor = createDefaultActionExecutor();
        const controller = createPluginAccountDataEraseRecoveryController({ execute: executor.execute, modal,
            captureActiveAccountScopeLifetime: captureActiveServerAccountScopeLifetime });
        try {
            expect(captureActiveServerAccountScopeLifetime()?.isCurrent()).toBe(true);
            await controller.eraseKnownPlugin('example.compute');
            expect(requests, JSON.stringify({ alerts: modal.alert.mock.calls })).not.toHaveLength(0);
            expect(modal.confirm).toHaveBeenCalledTimes(2);
            expect(modal.confirm.mock.calls[1]?.[1]).toContain('native-1');
            expect(requests).toEqual([
                { pluginId: 'example.compute' },
                ...(choice === 'manual' ? [{ pluginId: 'example.compute', managedResourceDispositions: [{
                    managedId: resource.managedId, expectedIntentRevision: resource.intentRevision,
                    expectedAllocation: resource.allocation, expectedResource: resource.resource,
                    expectedNativeOperationRef: resource.nativeOperationRef, expectedRecovery: resource.recovery,
                    responsibility: 'manual',
                }] }] : []),
            ]);
            // A pending Data arm cannot authorize Settings deletion or show completed erase.
            expect(settingsWrites).toEqual([]);
            expect(modal.alert).toHaveBeenCalledTimes(choice === 'manual' ? 1 : 0);
        } finally { controller.retire(); }
    });
});
