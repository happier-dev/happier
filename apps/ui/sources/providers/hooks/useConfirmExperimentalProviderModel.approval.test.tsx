import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderSettingsAccountHarness, installProviderConnectionsCatalogHttpBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

const account = createProviderSettingsAccountHarness();
const navigation = createExpoRouterMock();
vi.doMock('expo-router', () => navigation.module);
vi.doMock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: { confirm: vi.fn(async () => true) },
}).module);
// Machine transport is a system boundary; the Account, Action and Artifact owners stay real.
const machineRpc = vi.fn(async () => { throw new Error('Unexpected machine effect'); });
vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
await loadSyncSingletonForTests();
const { useConfirmExperimentalProviderModel } = await import('./useConfirmExperimentalProviderModel');
const { useApprovalArtifact } = await import('@/components/approvals/useApprovalArtifact');
const { isApprovalReplayRouteUnavailable } = await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');
const { approvalArtifactBodyMatchesHeaderV1 } = await import('@happier-dev/protocol/approvals/approvalArtifactHeaderV1');

const confirmation = { kind: 'confirm-experimental', connectionId: 'pc_experimental', expectedConnectionRevision: 3,
    agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'deepseek-v4-flash',
    compatibilityFingerprint: 'compatibility:v1:experimental', providerName: 'DeepSeek', modelName: 'V4 Flash' } as const;
const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    connections: [{ v: 1, id: confirmation.connectionId, source: { kind: 'contribution',
        contributionKey: 'happier.provider.deepseek/deepseek' }, role: 'named', displayName: 'DeepSeek',
        displayNameMode: 'custom', revision: 3, createdAt: 1, updatedAt: 1 }],
});

beforeEach(async () => {
    standardCleanup(); await account.reset(); navigation.spies.push.mockClear(); machineRpc.mockClear();
});
afterEach(async () => { standardCleanup(); await account.reset(); });

describe('experimental model approval on its original composer', () => {
    it('settles rejection without selecting, writing or replaying on a machine-less Account', async () => {
        const { serverId } = await account.restore({ catalog, machines: [] });
        const row = installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId, catalog });
        await account.home.requireUiApproval(serverId, 'providers.models.experimental.confirm');
        const refresh = vi.fn(async () => {});
        const commit = vi.fn();
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({ enabled: true,
            machineId: null, serverId, agentTargetKey: confirmation.agentTargetKey, refresh }));
        let settled: boolean | null = null;
        await act(async () => { void hook.getCurrent().confirm(confirmation, commit).then(value => { settled = value; }); });
        await waitForHomeGovernance(() => expect(account.home.artifacts(serverId).list()).toHaveLength(1));
        const artifactId = account.home.artifacts(serverId).list()[0]!.id;
        expect(navigation.spies.push).not.toHaveBeenCalled();
        await expect(decideApprovalAsInbox(serverId, artifactId, 'reject')).resolves.toMatchObject({ ok: true });
        await waitForHomeGovernance(() => {
            expect(settled).toBe(false);
            expect(hook.getCurrent().pending).toBe(false);
            expect(hook.getCurrent().pendingApproval).toBeNull();
        });
        expect(commit).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(row.writes).toBe(0);
        expect(machineRpc).not.toHaveBeenCalled();
    });

    it('stays in place and commits the exact selection once after the original Account approval executes', async () => {
        const { serverId } = await account.restore({ catalog, machines: [] });
        const row = installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId, catalog });
        await account.home.requireUiApproval(serverId, 'providers.models.experimental.confirm');
        const refresh = vi.fn(async () => {});
        const commit = vi.fn();
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({ enabled: true,
            machineId: 'machine-a', serverId, agentTargetKey: confirmation.agentTargetKey, refresh }));
        let settled: boolean | null = null;
        await act(async () => { void hook.getCurrent().confirm(confirmation, commit).then(value => { settled = value; }); });
        await waitForHomeGovernance(() => expect(account.home.artifacts(serverId).list()).toHaveLength(1));
        const artifactId = account.home.artifacts(serverId).list()[0]!.id;
        expect(navigation.spies.push).not.toHaveBeenCalled();
        expect(hook.getCurrent().pending).toBe(true);
        expect(hook.getCurrent().pendingModelName).toBe(confirmation.modelName);
        expect(hook.getCurrent().pendingApproval).toEqual({ artifactId,
            href: `/inbox/approvals/${artifactId}?serverId=${encodeURIComponent(serverId)}` });
        expect(commit).not.toHaveBeenCalled();
        expect(row.writes).toBe(0);
        await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'approved' } });
        await waitForHomeGovernance(() => {
            expect(settled).toBe(true);
            expect(hook.getCurrent().pendingModelName).toBeNull();
            expect(hook.getCurrent().pending).toBe(false);
            expect(hook.getCurrent().pendingApproval).toBeNull();
        });
        expect(commit).toHaveBeenCalledOnce();
        expect(row.writes).toBe(1);
        expect(row.catalog.experimentalBindingConfirmations).toEqual([expect.objectContaining({
            connectionId: confirmation.connectionId, agentTargetKey: confirmation.agentTargetKey,
            modelId: confirmation.modelId, compatibilityFingerprint: confirmation.compatibilityFingerprint,
        })]);
        expect(machineRpc).not.toHaveBeenCalled();
    });

    it('keeps a readable present-user approval on a reachable Home without demanding a portable daemon replay origin', async () => {
        const { serverId } = await account.restore({ catalog, machines: [] });
        await account.home.requireUiApproval(serverId, 'providers.models.experimental.confirm');
        const hook = await renderHook(() => useConfirmExperimentalProviderModel({ enabled: true,
            machineId: 'machine-a', serverId, agentTargetKey: confirmation.agentTargetKey, refresh: async () => {} }));
        await act(async () => { void hook.getCurrent().confirm(confirmation, () => {}); });
        await waitForHomeGovernance(() => expect(account.home.artifacts(serverId).list()).toHaveLength(1));
        const artifactId = account.home.artifacts(serverId).list()[0]!.id;
        const reader = await renderHook(() => useApprovalArtifact({ artifactId, serverId }));
        await waitForHomeGovernance(() => expect(reader.getCurrent().artifact?.body).toBeTruthy());
        const artifact = reader.getCurrent().artifact!;
        if (typeof artifact.body !== 'string') throw new Error('Expected the decoded approval body');
        const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body);
        expect(parsed?.family).toBe('built_in');
        if (parsed?.family !== 'built_in') throw new Error('Expected built-in approval');
        expect(isApprovalReplayRouteUnavailable(parsed.request)).toBe(false);
        expect(reader.getCurrent().homeUnavailable).toBe(false);
        expect(reader.getCurrent().error).toBe(false);
        await expect(decideApprovalAsInbox(serverId, artifactId, 'reject')).resolves.toMatchObject({ ok: true });
        expect(machineRpc).not.toHaveBeenCalled();
    });
});
