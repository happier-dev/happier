import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SessionDraftDocumentV1 } from '@happier-dev/protocol/drafts/sessionDrafts';
import { createMachineFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { NewSessionDraftProjection } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { setPreferredLanguageFromSettings } from '@/text/i18n';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// The scoped RPC leaves the process; catalog, credentials, cache, rows and icons stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { NewSessionDraftsSectionView } = await import('./NewSessionDraftsSection');
const { AgentCatalogIdentityIcon } = await import('@/agents/presentation/AgentCatalogIdentityIcon');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
await loadSyncSingletonForTests();

afterEach(async () => {
    setPreferredLanguageFromSettings(null);
    standardCleanup();
    clearDaemonMergedProjectionCacheForTests();
    await homes.reset();
    vi.restoreAllMocks();
});

describe('draft identity projection fan-out', () => {
    it('mounts sixty real draft rows using the scope owner’s single credential read and publication', async () => {
        await homes.reset();
        installHomeGovernanceBoundaries(homes);
        const profileId = await homes.addHome({ name: 'Draft Home', serverUrl: 'https://draft-fanout.example.test',
            serverIdentityId: 'srv_draft_fanout', accountId: 'draft-account' });
        const serverId = resolveServerProfileScopeIdForIdentifier(profileId);
        const machine = createMachineFixture({ id: 'draft-machine', activeAt: Date.now() });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
        rpc.mockReset();
        rpc.mockImplementation(async (call: Readonly<{ method: string }>) => {
            if (call.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                throw new Error(`Unexpected fanout RPC ${call.method}`);
            }
            return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {} } };
        });
        const credentialReads = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
        const owner = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
        await waitForHomeGovernance(() => expect(owner.getCurrent().get(serverId)?.isCurrent()).toBe(true));
        await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: machine.id, serverId,
            accountLifetime: owner.getCurrent().get(serverId) });
        const drafts: NewSessionDraftProjection[] = Array.from({ length: 60 }, (_, index) => {
            const document: SessionDraftDocumentV1 = { v: 1, extensions: {}, composer: {
                text: { mutationId: 'text', value: 'A retained draft' }, mentions: { mutationId: 'mentions', value: [] },
                attachments: { mutationId: 'attachments', value: [] },
            }, target: { kind: 'newSession', authoring: {
                serverId: { mutationId: 'server', value: serverId }, machineId: { mutationId: 'machine', value: machine.id },
                agentId: { mutationId: 'agent', value: 'claude' }, directory: { mutationId: 'directory', value: '/repo' },
            } } };
            return {
                draftId: `draft-${index}`, status: 'pending', conflict: null, createdAt: 1, updatedAt: 2, localSupplement: {},
                document, readView: {
                    address: { kind: 'newSession', draftId: `draft-${index}` }, revision: 0, materialized: true,
                    status: 'pending', conflict: null, createdAt: 1, updatedAt: 2, localSupplement: {},
                    composer: document.composer, documentVersion: 1, targetKind: 'newSession',
                },
            } satisfies NewSessionDraftProjection;
        });
        let commits = 0;
        const screen = await renderScreen(<React.Profiler id="draft-cohort" onRender={() => { commits += 1; }}>
            <NewSessionDraftsSectionView drafts={drafts} density="minimal" serverId={serverId}
                onContinue={() => undefined} onDelete={async () => false} />
        </React.Profiler>);
        await flushHookEffects({ cycles: 3, turns: 2 });
        // A long group lists its newest few; open it whole so the full cohort of sixty rows is mounted.
        // The open is one commit of its own; the counts below exclude it.
        await act(async () => screen.findByTestId('session-drafts-show-all')?.props.onPress());
        await flushHookEffects({ cycles: 3, turns: 2 });
        commits -= 1;
        expect(screen.findAllByTestId('session-draft-row:new-session:draft-0').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('session-draft-agent-logo:new-session:draft-59').length).toBeGreaterThan(0);
        // The one credential binding and daemon publication precede the cohort:
        // mounting summary consumers must not restart either owner.
        expect(credentialReads.mock.calls.filter(([, options]) => options?.serverId === serverId)).toHaveLength(1);
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(commits).toBe(1);
        const marks = () => screen.tree.root.findAllByType(AgentCatalogIdentityIcon);
        expect(marks()).toHaveLength(60);
        expect(marks().every(mark => mark.props.current === true)).toBe(true);
        // The one cache publication updates the mounted cohort. Revision
        // invalidation withdraws authority while preserving the identity rows.
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({ machineId: machine.id, serverId }, 'authority'));
        expect(marks().every(mark => mark.props.current === false)).toBe(true);
        expect(commits).toBe(2);
        await act(async () => {
            await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: machine.id, serverId,
                accountLifetime: owner.getCurrent().get(serverId) });
        });
        expect(marks().every(mark => mark.props.current === true)).toBe(true);
        expect(commits).toBe(3);
        await act(async () => owner.unmount());
        expect(marks().every(mark => mark.props.current === false)).toBe(true);
        expect(commits).toBe(4);
        expect(credentialReads.mock.calls.filter(([, options]) => options?.serverId === serverId)).toHaveLength(1);
        // A memoized, otherwise unchanged row must not retain the previous UI locale.
        await act(async () => setPreferredLanguageFromSettings('fr'));
        expect(screen.findByTestId('session-draft-delete:new-session:draft-0')?.props.accessibilityLabel).toBe('Supprimer le brouillon');
        await act(async () => setPreferredLanguageFromSettings('en'));
        expect(screen.findByTestId('session-draft-delete:new-session:draft-0')?.props.accessibilityLabel).toBe('Delete draft');
    });
});
