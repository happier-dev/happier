import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { settingsParse } from '@/sync/domains/settings/settings';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { storage } = await import('@/sync/domains/state/storage');
const {
    selectComposerApprovalRequestsForSurface,
    useComposerApprovalRequests,
    useFailedApprovalDismissal,
} = await import('./failedApprovalDismissal');
const initialState = storage.getState();
const { dismissFailedApproval, migrateFailedApprovalDismissals, failedApprovalDismissalScopeKey } = await import('@/sync/domains/state/failedApprovalUiState');
const { UiStatePersistenceError } = await import('@/sync/domains/state/persistentUiState');

afterEach(() => {
    standardCleanup();
    storage.setState(initialState, true);
});

function request(artifactId: string, settled: 'open' | 'failed'): OpenApprovalArtifactForSession {
    const approval = settled === 'open'
        ? { v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent', sessionId: 's' },
            requestedSurface: 'agent', actionId: 'session.list', actionArgs: {}, summary: 'List sessions' }
        : { v: 1, status: 'executed', createdAtMs: 1, updatedAtMs: 2, createdBy: { surface: 'agent', sessionId: 's' },
            requestedSurface: 'agent', actionId: 'session.list', actionArgs: {}, summary: 'List sessions',
            decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: false, errorCode: 'boom', error: 'boom' } };
    return { artifact: { id: artifactId, header: { title: null } }, approval: approval as ApprovalRequest } as OpenApprovalArtifactForSession;
}

describe('failed approval dismissal', () => {
    it.each(['dismissal', 'migration'] as const)('preserves earlier durable dismissals when a %s read transiently refuses', async operation => {
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const adapter = getPersistenceStorage();
        const scopeKey = failedApprovalDismissalScopeKey({ serverId: `dg8-read-${operation}`, accountId: 'alice' });
        const destination = `ui-state:failed-approval-dismissals-v1:${scopeKey}`;
        adapter.set(destination, JSON.stringify({ old: 10 }));
        const read = adapter.getString.bind(adapter);
        let reads = 0;
        const refusedRead = vi.spyOn(adapter, 'getString').mockImplementation(key => {
            if (key === destination && ++reads === 1) throw new Error('device read refused');
            return read(key);
        });
        const write = vi.spyOn(adapter, 'set');
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            let error: unknown;
            try {
                if (operation === 'dismissal') dismissFailedApproval(scopeKey, 'new');
                else migrateFailedApprovalDismissals(scopeKey, { legacy: 20 });
            } catch (caught) { error = caught; }
            expect(JSON.parse(read(destination)!)).toEqual({ old: 10 });
            expect(error).toBeInstanceOf(UiStatePersistenceError);
            expect(write).not.toHaveBeenCalled();
            expect(reads).toBe(1);
            // A later explicit intent can succeed after storage recovers; the failed intent never retries itself.
            if (operation === 'dismissal') dismissFailedApproval(scopeKey, 'new');
            else migrateFailedApprovalDismissals(scopeKey, { legacy: 20 });
            expect(JSON.parse(read(destination)!)).toEqual(operation === 'dismissal'
                ? { old: 10, new: expect.any(Number) }
                : { old: 10, legacy: 20 });
        } finally { refusedRead.mockRestore(); write.mockRestore(); warning.mockRestore(); }
    });

    it('handles a typed dismissal write refusal without changing the retained record', async () => {
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const adapter = getPersistenceStorage();
        const scope = { serverId: 'dg8-write-refusal', accountId: 'alice' };
        const destination = `ui-state:failed-approval-dismissals-v1:${failedApprovalDismissalScopeKey(scope)}`;
        adapter.set(destination, JSON.stringify({ old: 10 }));
        storage.setState({ profileScope: scope });
        const hook = await renderHook(() => useFailedApprovalDismissal());
        const set = adapter.set.bind(adapter);
        const refusedWrite = vi.spyOn(adapter, 'set').mockImplementation((key, value) => {
            if (key === destination) throw new Error('private storage details');
            set(key, value);
        });
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await act(async () => { hook.getCurrent().dismiss('new'); });
            expect(JSON.parse(adapter.getString(destination)!)).toEqual({ old: 10 });
            expect(hook.getCurrent().dismissed).toEqual({ old: 10 });
            expect(warning.mock.calls.flat().join(' ')).not.toContain('private storage details');
        } finally { refusedWrite.mockRestore(); warning.mockRestore(); }
    });

    it.each([
        { surface: 'composer', expectedComposerIds: ['open-1', 'failed-1'] },
        { surface: 'transcript', expectedComposerIds: ['failed-1'] },
    ] as const)('keeps mixed open and failed approvals on exactly one owned surface for $surface preference', ({ surface, expectedComposerIds }) => {
        const requests = [request('open-1', 'open'), request('failed-1', 'failed')];
        const composerIds = selectComposerApprovalRequestsForSurface(requests, surface).map(item => item.artifact.id);
        const transcriptIds = surface === 'transcript' ? ['open-1'] : [];

        expect(composerIds).toEqual(expectedComposerIds);
        expect([...composerIds, ...transcriptIds].sort()).toEqual(['failed-1', 'open-1']);
    });

    it('remembers only the dismissed settled card on this device with Settings writes Off', async () => {
        storage.setState({ profileScope: { serverId: 'dismissal-home', accountId: 'dismissal-account' } });
        storage.setState(state => ({ settings: settingsParse({ ...state.settings,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }) }));
        const requests = [request('open-1', 'open'), request('failed-1', 'failed'), request('failed-2', 'failed')];
        const approvalsBefore = JSON.stringify(requests);
        let hook = await renderHook(() => ({ shown: useComposerApprovalRequests(requests), dismissal: useFailedApprovalDismissal() }));
        expect(hook.getCurrent().shown.map(item => item.artifact.id)).toEqual(['open-1', 'failed-1', 'failed-2']);

        await act(async () => { hook.getCurrent().dismissal.dismiss('failed-1'); });
        expect(hook.getCurrent().shown.map(item => item.artifact.id)).toEqual(['open-1', 'failed-2']);
        expect(storage.getState().localSettings.dismissedFailedApprovalsV1['failed-1']).toBeUndefined();
        const { clearPersistenceStorage, getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const key = 'ui-state:failed-approval-dismissals-v1:["dismissal-home","dismissal-account"]';
        const raw = getPersistenceStorage().getString(key)!;
        expect(JSON.parse(raw))
            .toEqual({ 'failed-1': expect.any(Number) });
        await hook.unmount();
        // Cold reload of this isolated device fixture must read durable bytes, not the owner cache.
        clearPersistenceStorage();
        getPersistenceStorage().set(key, raw);
        hook = await renderHook(() => ({ shown: useComposerApprovalRequests(requests), dismissal: useFailedApprovalDismissal() }));
        expect(hook.getCurrent().shown.map(item => item.artifact.id)).toEqual(['open-1', 'failed-2']);
        expect(JSON.stringify(requests)).toBe(approvalsBefore);
        await hook.unmount();
    });

    it('never hides an open approval, even one carrying a stale dismissal', async () => {
        await act(async () => { storage.getState().applyLocalSettings({ dismissedFailedApprovalsV1: { 'open-1': 1 } }); });
        const requests = [request('open-1', 'open')];
        const hook = await renderHook(() => useComposerApprovalRequests(requests));
        expect(hook.getCurrent().map(item => item.artifact.id)).toEqual(['open-1']);
    });

    it('isolates Home/Account dismissals and retires them at Artifact deletion and exhausted inventory removal', async () => {
        storage.setState({ profileScope: { serverId: 'lifecycle-home', accountId: 'alice' } });
        const hook = await renderHook(() => useFailedApprovalDismissal());
        const artifact = { id: 'lifecycle-failure', title: 'Failed approval', createdAt: 1, updatedAt: 1,
            headerVersion: 1, seq: 1, isDecrypted: true as const, draft: false };
        act(() => {
            storage.getState().addArtifact(artifact);
            hook.getCurrent().dismiss(artifact.id);
        });
        expect(hook.getCurrent().dismissed[artifact.id]).toEqual(expect.any(Number));
        act(() => storage.setState({ profileScope: { serverId: 'other-home', accountId: 'alice' } }));
        expect(hook.getCurrent().dismissed[artifact.id]).toBeUndefined();
        act(() => storage.setState({ profileScope: { serverId: 'lifecycle-home', accountId: 'bob' } }));
        expect(hook.getCurrent().dismissed[artifact.id]).toBeUndefined();
        act(() => storage.setState({ profileScope: { serverId: 'lifecycle-home', accountId: 'alice' } }));
        expect(hook.getCurrent().dismissed[artifact.id]).toEqual(expect.any(Number));
        act(() => storage.getState().deleteArtifact(artifact.id));
        expect(hook.getCurrent().dismissed[artifact.id]).toBeUndefined();
        act(() => {
            storage.getState().addArtifact(artifact);
            hook.getCurrent().dismiss(artifact.id);
            storage.getState().applyArtifacts([], storage.getState().artifacts);
        });
        expect(hook.getCurrent().dismissed[artifact.id]).toBeUndefined();
    });

    it('qualifies only legacy dismissal ids actually observed in this Home/Account', async () => {
        storage.setState({ profileScope: { serverId: 'legacy-dismissal-home', accountId: 'alice' },
            localSettings: { ...storage.getState().localSettings,
                dismissedFailedApprovalsV1: { 'legacy-failed': 12, 'unknown-owner': 13 } } });
        const hook = await renderHook(() => ({ shown: useComposerApprovalRequests([request('legacy-failed', 'failed')]),
            dismissal: useFailedApprovalDismissal() }));
        expect(hook.getCurrent().shown).toEqual([]);
        expect(hook.getCurrent().dismissal.dismissed).toEqual({ 'legacy-failed': 12 });
        expect(storage.getState().localSettings.dismissedFailedApprovalsV1).toEqual({ 'unknown-owner': 13 });
    });

    it.each(['partial', 'unreadable'] as const)('preserves dismissal through a %s inventory observation until actual deletion', async publication => {
        storage.setState({ profileScope: { serverId: `inventory-${publication}`, accountId: 'alice' } });
        const hook = await renderHook(() => useFailedApprovalDismissal());
        const artifact = { id: `failed-${publication}`, title: 'Failed approval', createdAt: 1, updatedAt: 1,
            headerVersion: 1, seq: 1, isDecrypted: true as const, draft: false };
        act(() => {
            storage.getState().addArtifact(artifact);
            hook.getCurrent().dismiss(artifact.id);
            storage.getState().applyArtifacts([], storage.getState().artifacts, undefined, publication);
        });
        expect(hook.getCurrent().dismissed[artifact.id]).toEqual(expect.any(Number));
        act(() => storage.getState().deleteArtifact(artifact.id));
        expect(hook.getCurrent().dismissed[artifact.id]).toBeUndefined();
    });

    it('retires withdrawn dismissals on full inventory absence while retaining raced additions', async () => {
        storage.setState({ profileScope: { serverId: 'full-inventory-retirement', accountId: 'alice' } });
        const hook = await renderHook(() => useFailedApprovalDismissal());
        const withdrawn = { id: 'withdrawn-failure', title: 'Failed approval', createdAt: 1, updatedAt: 1,
            headerVersion: 1, seq: 1, isDecrypted: true as const, draft: false };
        const raced = { ...withdrawn, id: 'raced-failure' };
        act(() => {
            storage.getState().addArtifact(withdrawn);
            hook.getCurrent().dismiss(withdrawn.id);
            storage.getState().applyArtifacts([], storage.getState().artifacts, undefined, 'unreadable');
        });
        expect(hook.getCurrent().dismissed[withdrawn.id]).toEqual(expect.any(Number));
        const baseline = storage.getState().artifacts;
        act(() => {
            storage.getState().applyArtifacts([], baseline, ['prompt_doc.v2']);
            storage.getState().addArtifact(raced);
            hook.getCurrent().dismiss(raced.id);
        });
        expect(hook.getCurrent().dismissed[withdrawn.id]).toEqual(expect.any(Number));
        act(() => storage.getState().applyArtifacts([], baseline));
        expect(hook.getCurrent().dismissed[withdrawn.id]).toBeUndefined();
        expect(hook.getCurrent().dismissed[raced.id]).toEqual(expect.any(Number));
        expect(storage.getState().artifacts[raced.id]).toBeDefined();
    });

    it('retains unqualified timestamps if the device refuses their scoped migration', async () => {
        storage.setState({ profileScope: { serverId: 'refused-dismissal-home', accountId: 'alice' },
            localSettings: { ...storage.getState().localSettings, dismissedFailedApprovalsV1: { 'refused-failure': 21 } } });
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const adapter = getPersistenceStorage();
        const write = adapter.set.bind(adapter);
        const failure = vi.spyOn(adapter, 'set').mockImplementation((key, value) => {
            if (key.startsWith('ui-state:failed-approval-dismissals-v1:')) throw new Error('private storage details');
            write(key, value);
        });
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const hook = await renderHook(() => useComposerApprovalRequests([request('refused-failure', 'failed')]));
            expect(hook.getCurrent()).toEqual([]);
            expect(storage.getState().localSettings.dismissedFailedApprovalsV1).toEqual({ 'refused-failure': 21 });
            expect(warning.mock.calls.flat().join(' ')).not.toContain('private storage details');
        } finally { failure.mockRestore(); warning.mockRestore(); }
    });
});
