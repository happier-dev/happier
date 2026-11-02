import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { MachineAccessGrantsListResponseV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { createMachineFixture, renderScreen } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { ShareSheet } from '../ShareSheet';
import { createMachineShareAdapter } from './machineShareAdapter';
import { useMachineShareController } from './useMachineShareController';
import { t } from '@/text';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { AccountProfileSchema } from '@happier-dev/protocol';
import { getStorage } from '@/sync/domains/state/storage';
import { teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit');
    return { LegendList: createCapturingLegendListMock({ renderItems: true }).module.LegendList };
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ renderCustomModals: true, spies: { confirm: vi.fn(async () => true) } }).module;
});

const bob = { kind: 'account' as const, accountId: 'bob' };
const initial: MachineAccessGrantsListResponseV1 = {
    machineId: 'machine', custodian: { accountId: 'alice', displayName: 'Alice' },
    access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
    canManage: true, ownDirectGrant: false, ownAccessSources: [],
    grants: [{ machineId: 'machine', principal: bob, level: 'view', display: { name: 'Bob' }, readiness: 'ready',
        audience: [{ accountId: 'bob', displayName: 'Bob', readiness: 'ready', reason: null, canPrepareKeys: false }],
        removal: { losesAccessAccountIds: ['bob'] } }],
};

describe('Machine sharing through the canonical controller and sheet', () => {
    it('projects guest placement from the exact Machine policy without changing grants', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://guest-placement.test', accountId: 'alice' }],
            route: request => request.path === '/v1/machines/machine/access' && request.method === 'GET' ? Response.json(initial) : undefined });
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: 'alice' };
            let current: ReturnType<typeof useMachineShareController> | undefined;
            function Surface() { current = useMachineShareController({ machineId: 'machine', machineName: 'Devbox', scope }); return null; }
            screen = await renderScreen(<Surface />);
            await vi.waitFor(() => expect(current?.response?.canManage).toBe(true));
            expect(current?.guestExecution.placement).toBeNull();
            for (const [platform, agentIsolation, placement, offer] of [
                ['linux', undefined, 'daemon', true],
                ['linux', { enabled: true }, 'sharedAgent', true],
                ['linux', { enabled: true, memberProvisioning: 'linuxUsersV1' }, 'member', false],
                ['linux', { enabled: false, memberProvisioning: 'linuxUsersV1' }, 'daemon', true],
                ['darwin', { enabled: false }, 'daemon', false],
                ['win32', { enabled: false }, 'daemon', false],
            ] as const) {
                const base = createMachineFixture({ id: 'machine' });
                await act(async () => getStorage().getState().applyMachines([
                    { ...base, metadata: { ...base.metadata!, platform, ...(agentIsolation ? { agentIsolation } : {}) } },
                ], true, { sourceServerId: scope.serverId }));
                expect(current?.guestExecution).toMatchObject({ placement, showOwnerUserDisclosure: placement !== 'member', canEnableSeparateUsers: offer });
            }
            expect(home.requests.filter(request => request.path.startsWith('/v1/machines/') && request.method !== 'GET')).toEqual([]);
        } finally {
            await screen?.unmount();
            getStorage().getState().applyMachines([], true, { sourceServerId: home.homes.machine!.id });
            const { clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
            clearMachineRequestReachabilityForTest();
            await home.dispose();
        }
    });

    it('keeps the mounted share modal presence bound to its exact Home and Account', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-share-presence.test', accountId: 'alice' }],
            route: request => request.path === '/v1/machines/machine/access' && request.method === 'GET' ? Response.json(initial) : undefined });
        const { Modal, ModalProvider } = await import('@/modal');
        const { showMachineShareSheet } = await import('./MachineSharingSection');
        const { withdrawMachinePresenceForScope, captureMachinePresenceObservation, clearMachineRequestReachabilityForTest } =
            await import('@/sync/domains/machines/reachability/machineReachability');
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: 'alice' };
            const machine = createMachineFixture({ id: 'machine', active: false, activeAt: 1 });
            const applyMachine = () => getStorage().getState().applyMachines([machine], true, { sourceServerId: scope.serverId });
            applyMachine();
            screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
            await act(async () => showMachineShareSheet({ machineId: machine.id, machineName: 'Devbox', scope, online: false }));
            const offline = () => screen!.findByTestId('machine-share-offline') !== null;
            await vi.waitFor(() => expect(offline()).toBe(true));
            await act(async () => withdrawMachinePresenceForScope(scope));
            expect(offline()).toBe(false);
            await act(async () => captureMachinePresenceObservation({ ...scope, accountId: 'bob' })([machine.id]));
            expect(offline()).toBe(false);
            await act(async () => captureMachinePresenceObservation(scope)([machine.id]));
            expect(offline()).toBe(true);
            await act(async () => { await home.switchAccount('machine', 'bob'); applyMachine(); });
            expect(offline()).toBe(false);
        } finally {
            await act(async () => Modal.hideAll());
            await screen?.unmount();
            clearMachineRequestReachabilityForTest();
            await home.dispose();
        }
    });

    it.each([
        ['machines.access.grant.remove', false], ['machines.access.grant.remove', true],
        ['machines.access.leave', false], ['machines.access.leave', true],
    ] as const)('applies %s directly with waiver=%s without another local confirmation', async (actionId, waived) => {
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        const leaving = actionId === 'machines.access.leave';
        let snapshot: MachineAccessGrantsListResponseV1 = leaving ? { ...initial, canManage: false, grants: [], ownDirectGrant: true,
            access: { ...initial.access, role: 'use' }, ownAccessSources: [{ principal: bob, displayName: 'Bob' }] } : initial;
        const accountId = leaving ? 'bob' : 'alice';
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-removal-waiver.test', accountId, settings: {
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: waived ? { [actionId]: ['ui'] } : {} },
        } }], route: request => {
            if (request.path !== '/v1/machines/machine/access') return undefined;
            if (request.method === 'GET') return Response.json(snapshot);
            if (request.method === 'DELETE') {
                snapshot = { ...snapshot, grants: [], ownDirectGrant: false, ownAccessSources: [] };
                return Response.json(leaving ? { kind: 'left', effectiveAccess: 'none' } : { kind: 'removed', effectiveAccess: 'manage' });
            }
            return undefined;
        } });
        try {
            const scope = { serverId: home.homes.machine!.id, accountId };
            function Surface() {
                const controller = useMachineShareController({ machineId: 'machine', machineName: 'Devbox', scope });
                return <ShareSheet model={controller.model} actions={controller.actions}
                    adapter={createMachineShareAdapter({ machineName: 'Devbox', online: true, controller })}
                    presentation="full" testID="machine-share-editor" />;
            }
            const screen = await renderScreen(<Surface />);
            const rowId = leaving ? 'machine-share-your-access' : 'machine-share-grant-account:bob';
            await vi.waitFor(() => expect(screen.findByTestId(rowId)).not.toBeNull());
            await screen.pressByTestIdAsync(rowId);
            expect(screen.getTextContent()).toContain(t('machines.sharing.effectiveLoss'));
            await screen.pressByTestIdAsync('machine-share-remove:account:bob');
            await vi.waitFor(() => expect(home.requests.filter(request => request.method === 'DELETE')).toHaveLength(1));
            expect(home.requests.find(request => request.method === 'DELETE')?.body).toEqual(leaving ? {} : { principal: bob });
            expect(Modal.confirm).not.toHaveBeenCalled();
        } finally { await home.dispose(); }
    });
    it('retains dated census for transport loss, then clears it on denial and discards an older read', async () => {
        let mode: 'ready' | 'transport' | 'unavailable' | 'pending' | 'denied' = 'ready';
        let pending: { signal: AbortSignal | null | undefined; finish: (response: Response) => void } | undefined;
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-census-denial.test', accountId: 'alice' }],
            route: request => {
                if (request.path !== '/v1/machines/machine/access') return undefined;
                if (mode === 'transport') throw new TypeError('Network unavailable');
                if (mode === 'unavailable') return Response.json({ kind: 'refused', code: 'machine_unavailable' });
                if (mode === 'denied') return Response.json({ kind: 'refused', code: 'access_denied' });
                if (mode === 'pending') return new Promise<Response>(finish => { pending = { signal: request.signal, finish }; });
                return Response.json(initial);
            } });
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: 'alice' };
            let current: ReturnType<typeof useMachineShareController> | undefined;
            function Surface() {
                const controller = useMachineShareController({ machineId: 'machine', machineName: 'Devbox', scope });
                current = controller;
                return <ShareSheet model={controller.model} actions={controller.actions}
                    adapter={createMachineShareAdapter({ machineName: 'Devbox', online: true, controller })}
                    presentation="full" testID="machine-share-editor" />;
            }
            const screen = await renderScreen(<Surface />);
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-grant-account:bob')).not.toBeNull());
            mode = 'transport';
            await act(async () => { publishHomeAccountChange(scope.serverId, ['machine']); });
            await vi.waitFor(() => expect(current?.model.stale).toBe(true));
            expect(screen.findByTestId('machine-share-grant-account:bob')).not.toBeNull();
            expect(current?.model.editable).toBe(false);
            // The Action result union also admits typed refusals in an HTTP-success response.
            mode = 'unavailable';
            await act(async () => { publishHomeAccountChange(scope.serverId, ['machine']); });
            await vi.waitFor(() => expect(current?.issue?.code).toBe('machine_unavailable'));
            expect(screen.findByTestId('machine-share-grant-account:bob')).not.toBeNull();
            mode = 'pending';
            await act(async () => { publishHomeAccountChange(scope.serverId, ['machine']); });
            await vi.waitFor(() => expect(pending).toBeDefined());
            mode = 'denied';
            await act(async () => { publishHomeAccountChange(scope.serverId, ['machine']); });
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-grant-account:bob')).toBeNull());
            expect(current?.model.owner).toBeNull();
            expect(current?.response).toBeNull();
            expect(current?.issue?.code).toBe('access_denied');
            expect(pending?.signal?.aborted).toBe(true);
            await act(async () => { pending?.finish(Response.json(initial)); });
            expect(screen.findByTestId('machine-share-grant-account:bob')).toBeNull();
            expect(current?.model.owner).toBeNull();
        } finally { await home.dispose(); }
    });

    it('reads a failed access check as loading while the Home is still being reached, and reports it once the Home has answered', async () => {
        const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        let reads = 0;
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-settling.test', accountId: 'alice' }],
            route: request => {
                if (request.path !== '/v1/machines/machine/access') return undefined;
                reads++;
                throw new TypeError('Network unavailable');
            } });
        const before = getStorage().getState().endpointStatus;
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: 'alice' };
            publishAppliedActiveServerSnapshot({ ...getActiveServerSnapshot(), serverId: scope.serverId }, true);
            let current: ReturnType<typeof useMachineShareController> | undefined;
            function Surface() {
                const controller = useMachineShareController({ machineId: 'machine', machineName: 'Devbox', scope });
                current = controller;
                return <ShareSheet model={controller.model} actions={controller.actions}
                    adapter={createMachineShareAdapter({ machineName: 'Devbox', online: true, controller })}
                    presentation="full" testID="machine-share-editor" />;
            }
            const screen = await renderScreen(<Surface />);
            // A read that fails against a Home that is not answering is a transport failure.
            await vi.waitFor(() => expect(current?.issue?.message).toBe(t('machines.sharing.readError', { machine: 'Devbox' })));

            // Right after a restart the Home is still being connected: the same failure has not settled.
            await act(async () => { getStorage().setState({ endpointStatus: 'connecting', socketStatus: 'connecting' }); });
            expect(current?.loading).toBe(true);
            expect(current?.issue).toBeUndefined();
            expect(screen.getTextContent()).not.toContain(t('machines.sharing.readError', { machine: 'Devbox' }));
            expect(screen.getTextContent()).not.toContain(t('machines.sharing.unavailable', { machine: 'Devbox' }));

            // Once the Home has answered the read is made again, and a failure that persists is reported.
            const beforeSettled = reads;
            await act(async () => { getStorage().setState({ endpointStatus: 'online', socketStatus: 'connected' }); });
            await vi.waitFor(() => expect(current?.issue?.message).toBe(t('machines.sharing.readError', { machine: 'Devbox' })));
            expect(reads).toBeGreaterThan(beforeSettled);
            expect(current?.loading).toBe(false);
        } finally {
            publishAppliedActiveServerRuntimeAvailability(false);
            getStorage().setState({ endpointStatus: before });
            await home.dispose();
        }
    });
    it('retires the census and in-flight read on credential removal, and restores with a fresh same-Account read', async () => {
        const localStorage = installLocalStorageMock();
        const serverUrl = 'https://machine-census-credential.test';
        let snapshot = initial;
        let delay = false;
        let pending: { signal: AbortSignal | null | undefined; finish: (response: Response) => void } | undefined;
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl, accountId: 'alice' }],
            route: request => request.path === '/v1/machines/machine/access'
                ? delay ? new Promise<Response>(finish => { pending = { signal: request.signal, finish }; }) : Response.json(snapshot)
                : undefined });
        try {
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const scope = { serverId: home.homes.machine!.id, accountId: 'alice' };
            const credentials = { token: 'header.eyJzdWIiOiJhbGljZSJ9.signature' };
            expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, scope, credentials)).toBe(true);
            let current: ReturnType<typeof useMachineShareController> | undefined;
            function Surface() {
                const controller = useMachineShareController({ machineId: 'machine', machineName: 'Devbox', scope });
                current = controller;
                return <ShareSheet model={controller.model} actions={controller.actions}
                    adapter={createMachineShareAdapter({ machineName: 'Devbox', online: true, controller })}
                    presentation="full" testID="machine-share-editor" />;
            }
            const screen = await renderScreen(<Surface />);
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-grant-account:bob')).not.toBeNull());
            delay = true;
            await act(async () => { publishHomeAccountChange(scope.serverId, ['machine']); });
            await vi.waitFor(() => expect(pending).toBeDefined());
            await act(async () => { expect(await TokenStorage.removeCredentialsForServerUrl(serverUrl, scope)).toBe(true); });
            expect(screen.findByTestId('machine-share-grant-account:bob')).toBeNull();
            expect(current?.model.owner).toBeNull();
            expect(current?.response).toBeNull();
            expect(pending?.signal?.aborted).toBe(true);
            delay = false;
            snapshot = { ...initial, grants: [{ ...initial.grants[0]!, principal: { kind: 'account', accountId: 'cara' },
                display: { name: 'Cara' }, audience: [{ accountId: 'cara', displayName: 'Cara', readiness: 'ready', reason: null, canPrepareKeys: false }],
                removal: { losesAccessAccountIds: ['cara'] } }] };
            await act(async () => { expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, scope, credentials)).toBe(true); });
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-grant-account:cara')).not.toBeNull());
            await act(async () => { pending?.finish(Response.json(initial)); });
            expect(screen.findByTestId('machine-share-grant-account:bob')).toBeNull();
            expect(screen.findByTestId('machine-share-grant-account:cara')).not.toBeNull();
        } finally { await home.dispose(); localStorage.restore(); }
    });

    it('names only the Team members whose work loses effective access when another grant overlaps', async () => {
        const team = { kind: 'team' as const, teamId: 'team' };
        const snapshot: MachineAccessGrantsListResponseV1 = { ...initial, grants: [{ ...initial.grants[0]!, principal: team,
            display: { name: 'Teammates' }, audience: [
                { accountId: 'bob', displayName: 'Bob', readiness: 'ready', reason: null, canPrepareKeys: false },
                { accountId: 'cara', displayName: 'Cara', readiness: 'ready', reason: null, canPrepareKeys: false },
            ], removal: { losesAccessAccountIds: ['bob'] } }] };
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-removal-actors.test', accountId: 'alice' }],
            route: request => request.path === '/v1/machines/machine/access' ? Response.json(snapshot) : undefined });
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: 'alice' };
            function Surface() {
                const controller = useMachineShareController({ machineId: 'machine', machineName: 'Devbox', scope });
                return <ShareSheet model={controller.model} actions={controller.actions}
                    adapter={createMachineShareAdapter({ machineName: 'Devbox', online: true, controller })}
                    presentation="full" testID="machine-share-editor" />;
            }
            const screen = await renderScreen(<Surface />);
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-grant-team:team')).not.toBeNull());
            await screen.pressByTestIdAsync('machine-share-grant-team:team');
            await screen.pressByTestIdAsync('machine-share-remove:team:team');
            const consequences = screen.findAll(node => node.props.testID === 'machine-share-remove-consequence:team:team')
                .map(node => node.props.children).join(' ');
            expect(consequences).toContain('Bob');
            expect(consequences).not.toContain('Cara');
            expect(consequences).toContain(t('machines.sharing.effectiveLoss'));
        } finally { await home.dispose(); }
    });

    it('keeps mixed Team levels editable and explains incompatible members without offering futile key preparation', async () => {
        const team = { kind: 'team' as const, teamId: 'team' };
        const audience = [
            { accountId: 'bob', displayName: 'Bob', readiness: 'ready' as const, reason: null, canPrepareKeys: false },
            { accountId: 'cara', displayName: 'Cara', readiness: 'refused' as const,
                reason: 'recipient_encryption_incompatible' as const, canPrepareKeys: false },
        ];
        let snapshot: MachineAccessGrantsListResponseV1 = { ...initial, access: { ...initial.access, resourceMode: 'e2ee' as const }, grants: [{
            machineId: 'machine', principal: team, level: 'view' as const, display: { name: 'Mixed Team' },
            readiness: 'refused' as const, audience, removal: { losesAccessAccountIds: ['bob', 'cara'] },
        }] };
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-mixed-team.test', accountId: 'alice', settings: {
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.access.grant.set': ['ui'] } },
        } }], route: request => {
            if (request.path !== '/v1/machines/machine/access') return undefined;
            if (request.method === 'GET') return Response.json(snapshot);
            if (request.method === 'PUT') {
                snapshot = { ...snapshot, grants: snapshot.grants.map(row => ({ ...row, level: 'admin' })) };
                return Response.json({ kind: 'saved', grant: { machineId: 'machine', principal: team, level: 'admin' }, readiness: 'refused', canPrepareKeys: false });
            }
            return undefined;
        } });
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: 'alice' };
            function Surface() {
                const controller = useMachineShareController({ machineId: 'machine', machineName: 'Devbox', scope });
                return <ShareSheet model={controller.model} actions={controller.actions}
                    adapter={createMachineShareAdapter({ machineName: 'Devbox', online: true, controller })}
                    presentation="full" testID="machine-share-editor" />;
            }
            const screen = await renderScreen(<Surface />);
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-grant-team:team')).not.toBeNull());
            await screen.pressByTestIdAsync('machine-share-grant-team:team');
            expect(screen.findByTestId('machine-share-level:team:team:admin')?.props.disabled).toBe(false);
            expect(screen.findByTestId('machine-share-incompatible:team:team:cara')).not.toBeNull();
            expect(screen.findByTestId('machine-share-key-retry:team:team')).toBeNull();
            await screen.pressByTestIdAsync('machine-share-level:team:team:admin');
            await vi.waitFor(() => expect(home.requests.filter(request => request.method === 'PUT').map(request => request.body))
                .toEqual([{ principal: team, level: 'admin' }]));
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-level:team:team:admin')?.props.accessibilityState.checked).toBe(true));
            expect(home.requests.filter(request => request.path.includes('data-key-envelopes'))).toEqual([]);
            // A later eligible joiner is recoverable even while Cara remains incompatible.
            snapshot = { ...snapshot, grants: snapshot.grants.map(row => ({ ...row, audience: [
                ...row.audience, { accountId: 'dana', displayName: 'Dana', readiness: 'key_pending', reason: 'recipient_key_pending', canPrepareKeys: true },
            ] })) };
            await act(async () => { publishHomeAccountChange(scope.serverId, ['machine']); });
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-key-retry:team:team')).not.toBeNull());
            expect(screen.findByTestId('machine-share-incompatible:team:team:cara')).not.toBeNull();
        } finally { await home.dispose(); }
    });

    it('loads after StrictMode effect replay and retires every captured request lifetime before late results settle', async () => {
        const requests: Array<{ signal: AbortSignal | null | undefined; finish: (response: Response) => void }> = [];
        const setups: Array<{ retired: boolean }> = [];
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-effect-replay.test', accountId: 'alice' }],
            route: request => request.path === '/v1/machines/machine/access'
                ? new Promise<Response>(finish => { requests.push({ signal: request.signal, finish }); }) : undefined });
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: 'alice' };
            function Surface() {
                const controller = useMachineShareController({ machineId: 'machine', machineName: 'Devbox', scope });
                React.useEffect(() => {
                    const setup = { retired: false }; setups.push(setup);
                    return () => { setup.retired = true; };
                }, []);
                return <ShareSheet model={controller.model} actions={controller.actions}
                    adapter={createMachineShareAdapter({ machineName: 'Devbox', online: true, controller })}
                    presentation="full" testID="machine-share-editor" />;
            }
            const screen = await renderScreen(<Surface />, { wrapper: React.StrictMode });
            // Prove this renderer actually replayed setup/cleanup; a StrictMode wrapper alone is insufficient.
            expect(setups.map(setup => setup.retired)).toEqual([true, false]);
            await vi.waitFor(() => expect(requests.some(request => request.signal?.aborted === false)).toBe(true));
            const current = [...requests].reverse().find(request => request.signal?.aborted === false)!;
            await act(async () => { current.finish(Response.json(initial)); });
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-grant-account:bob')).not.toBeNull());
            await act(async () => { publishHomeAccountChange(scope.serverId, ['machine']); });
            const pending = [...requests].reverse().find(request => request !== current && request.signal?.aborted === false);
            expect(pending).toBeDefined();
            await screen.unmount();
            expect(setups.every(setup => setup.retired)).toBe(true);
            expect(pending?.signal?.aborted).toBe(true);
            expect(requests.filter(request => request !== current).every(request => request.signal?.aborted === true)).toBe(true);
            await act(async () => {
                for (const request of requests) request.finish(Response.json({ ...initial, grants: [] }));
            });
        } finally { await home.dispose(); }
    });

    it('refreshes external audience changes without losing a failed draft or expanded selection, ignoring another Home wake', async () => {
        let snapshot = initial;
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-freshness.test', accountId: 'alice', settings: {
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.access.grant.set': ['ui'] } },
        } }], route: request => {
            if (request.path !== '/v1/machines/machine/access') return undefined;
            if (request.method === 'GET') return Response.json(snapshot);
            if (request.method === 'PUT') return Response.json({ kind: 'refused', code: 'machine_unavailable' }, { status: 503 });
            return undefined;
        } });
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: 'alice' };
            getStorage().setState({ profile: AccountProfileSchema.parse({ id: 'alice', firstName: 'Alice' }), profileScope: scope });
            function Surface() {
                const controller = useMachineShareController({ machineId: 'machine', machineName: 'Devbox', scope });
                return <ShareSheet model={controller.model} actions={controller.actions}
                    adapter={createMachineShareAdapter({ machineName: 'Devbox', online: true, controller })}
                    presentation="full" testID="machine-share-editor" />;
            }
            const screen = await renderScreen(<Surface />);
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-grant-account:bob')).not.toBeNull());
            expect(screen.findAll(node => node.props.accessibilityLabel === `Alice, ${t('shareSheet.you')}`)).not.toHaveLength(0);
            screen.changeTextByTestId('machine-share-search', 'Bob');
            await screen.pressByTestIdAsync('machine-share-grant-account:bob');
            await screen.pressByTestIdAsync('machine-share-level:account:bob:admin');
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-retry:account:bob')).not.toBeNull());
            // The machine's effective role/content have not changed; only its weaker direct roster has.
            snapshot = { ...initial, grants: [...initial.grants, { machineId: 'machine', principal: { kind: 'account', accountId: 'cara' },
                level: 'view', display: { name: 'Cara' }, readiness: 'ready',
                audience: [{ accountId: 'cara', displayName: 'Cara', readiness: 'ready', reason: null, canPrepareKeys: false }],
                removal: { losesAccessAccountIds: ['cara'] } }] };
            const reads = home.requests.filter(request => request.path.endsWith('/access') && request.method === 'GET').length;
            publishHomeAccountChange('https://unrelated-home.test', ['machine']);
            publishHomeAccountChange(scope.serverId, ['unrelated-machine']);
            expect(home.requests.filter(request => request.path.endsWith('/access') && request.method === 'GET')).toHaveLength(reads);
            publishHomeAccountChange(scope.serverId, ['machine']);
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-grant-account:cara')).not.toBeNull());
            expect(home.requests.filter(request => request.path.endsWith('/access') && request.method === 'GET')).toHaveLength(reads + 1);
            expect(screen.findByTestId('machine-share-search')?.props.value).toBe('Bob');
            expect(screen.findByTestId('machine-share-retry:account:bob')).not.toBeNull();
            expect(screen.findByTestId('machine-share-level:account:bob:admin')?.props.accessibilityState.checked).toBe(true);
            expect(home.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
        } finally { await home.dispose(); }
    });
    it('offers Use and Manage, retains the exact failed level intent, and discloses effective loss in the same row', async () => {
        let snapshot = initial;
        let failSave = true;
        const writes: unknown[] = [];
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-share.test', accountId: 'alice', settings: {
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: {
                'machines.access.grant.set': ['ui'], 'machines.access.grant.remove': ['ui'],
            } },
        } }],
            route: (request) => {
                if (request.path === '/v1/teams/list') return Response.json({ items: [teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) })], nextCursor: null });
                if (request.path === '/v1/teams/groups/list') return Response.json({ items: [], nextCursor: null });
                if (request.path !== '/v1/machines/machine/access') return undefined;
                if (request.method === 'GET') return Response.json(snapshot);
                writes.push(request.body);
                if (failSave) return Response.json({ kind: 'refused', code: 'machine_unavailable' }, { status: 503 });
                snapshot = { ...snapshot, grants: snapshot.grants.map(row => ({ ...row, level: 'admin' })) };
                return Response.json({ kind: 'saved', grant: { machineId: 'machine', principal: bob, level: 'admin' }, readiness: 'ready', canPrepareKeys: false });
            } });
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: 'alice' };
            function Surface() {
                const controller = useMachineShareController({ machineId: 'machine', machineName: 'Devbox', scope });
                return <ShareSheet model={controller.model} actions={controller.actions}
                    adapter={createMachineShareAdapter({ machineName: 'Devbox', online: false, controller })}
                    presentation="full" testID="machine-share-editor" />;
            }
            const screen = await renderScreen(<Surface />);
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-grant-account:bob')).not.toBeNull());
            screen.changeTextByTestId('machine-share-search', 'Bob');
            await screen.pressByTestIdAsync('machine-share-grant-account:bob');
            expect(screen.findByTestId('machine-share-level:account:bob:edit')).toBeNull();
            await screen.pressByTestIdAsync('machine-share-level:account:bob:admin');
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-retry:account:bob')).not.toBeNull());
            expect(screen.findByTestId('machine-share-level:account:bob:admin')?.props.accessibilityState.checked).toBe(true);
            // The row shows the unsaved draft as chosen, so the failure says which change did not save and what holds.
            expect(screen.getTextContent()).toContain(t('machines.sharing.saveFailed', {
                person: 'Bob', draft: t('machines.sharing.manage'), current: t('machines.sharing.use') }));
            failSave = false;
            await screen.pressByTestIdAsync('machine-share-retry:account:bob');
            await vi.waitFor(() => {
                expect(writes).toHaveLength(2);
                expect(screen.findByTestId('machine-share-level:account:bob:admin')?.props.disabled).toBe(false);
            });
            expect(screen.findByTestId('machine-share-retry:account:bob')).toBeNull();
            expect(screen.findByTestId('machine-share-search')?.props.value).toBe('Bob');
            expect(writes).toEqual([{ principal: bob, level: 'admin' }, { principal: bob, level: 'admin' }]);
            expect(screen.findByTestId('machine-share-remove-consequence:account:bob')?.props.children).toBe(`Bob: ${t('machines.sharing.effectiveLoss')}`);
            expect(screen.findByTestId('machine-share-trusted-os')).not.toBeNull();
            expect(screen.getTextContent()).toContain(t('machines.sharing.trustedOsLead', { machine: 'Devbox' }));
            // The trust fact is one line at the point of choice; its explanation waits behind Details.
            expect(screen.getTextContent()).not.toContain(t('machines.sharing.trustedOsDetail', { machine: 'Devbox' }));
            expect(screen.findByTestId('machine-share-remove-confirm:account:bob')).toBeNull();
            expect(screen.findByTestId('machine-share-remove:account:bob')).not.toBeNull();
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-browse:team')).not.toBeNull());
            await screen.pressByTestIdAsync('machine-share-browse:team');
            expect(screen.findByTestId('machine-share-trusted-os')).not.toBeNull();
            await screen.pressByTestIdAsync('machine-share-editor:list:header:leading:back-chip');
            expect(screen.findByTestId('machine-share-search')?.props.value).toBe('Bob');
            expect(screen.findByTestId('machine-share-remove:account:bob')).not.toBeNull();
            // Details holds the same facts: why to trust them, what Manage adds (label and meaning as two parts,
            // never one run-on sentence) and the plain machine's readability.
            await screen.pressByTestIdAsync('machine-share-help');
            const details = screen.getTextContent();
            expect(details).toContain(t('machines.sharing.trustedOsDetail', { machine: 'Devbox' }));
            expect(details).toContain(`${t('machines.sharing.manage')} — ${t('machines.sharing.manageHelp', { machine: 'Devbox' })}`);
            expect(details).toContain(t('machines.sharing.plain'));
        } finally { await home.dispose(); }
    });

    it.each(['reduction', 'widening', 'new'] as const)('confirms named sharing exposure but applies a reduction directly (%s)', async scenario => {
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockClear();
        let snapshot: MachineAccessGrantsListResponseV1 = { ...initial, grants: scenario === 'new' ? [{
            ...initial.grants[0]!, principal: { kind: 'account', accountId: 'cara' }, level: 'admin', display: { name: 'Cara' },
            audience: [{ accountId: 'cara', displayName: 'Cara', readiness: 'ready', reason: null, canPrepareKeys: false }],
            removal: { losesAccessAccountIds: ['cara'] },
        }]
            : initial.grants.map(row => ({ ...row, level: scenario === 'reduction' ? 'admin' : 'view' })) };
        const level = scenario === 'reduction' || scenario === 'new' ? 'view' : 'admin';
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-share-confirm.test', accountId: 'alice', settings: {
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: {} },
        } }],
            route: (request) => {
                if (request.path === '/v1/user/search') return Response.json({ users: [{
                    id: 'bob', username: 'bob', firstName: 'Bob', lastName: null, avatar: null, bio: null,
                    status: 'none', publicKey: null,
                }], nextCursor: null });
                if (request.path === '/v1/teams/list') return Response.json({ items: [teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) })], nextCursor: null });
                if (request.path === '/v1/teams/groups/list') return Response.json({ items: [], nextCursor: null });
                if (request.path !== '/v1/machines/machine/access') return undefined;
                if (request.method === 'GET') return Response.json(snapshot);
                snapshot = { ...snapshot, grants: [...snapshot.grants.filter(row => row.principal.kind !== 'account'
                    || row.principal.accountId !== 'bob'), { ...initial.grants[0]!, level }] };
                return Response.json({ kind: 'saved', grant: { machineId: 'machine', principal: bob, level }, readiness: 'ready', canPrepareKeys: false });
            } });
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: 'alice' };
            function Surface() {
                const controller = useMachineShareController({ machineId: 'machine', machineName: 'Devbox', scope });
                return <ShareSheet model={controller.model} actions={controller.actions}
                    adapter={createMachineShareAdapter({ machineName: 'Devbox', online: true, controller })}
                    presentation="full" testID="machine-share-editor" />;
            }
            const screen = await renderScreen(<Surface />);
            if (scenario === 'new') {
                await vi.waitFor(() => expect(screen.findByTestId('machine-share-search')).not.toBeNull());
                screen.changeTextByTestId('machine-share-search', 'bob');
                await vi.waitFor(() => expect(screen.findByTestId('machine-share-candidate-account:bob')).not.toBeNull());
                await screen.pressByTestIdAsync('machine-share-candidate-account:bob');
            } else {
                await vi.waitFor(() => expect(screen.findByTestId('machine-share-grant-account:bob')).not.toBeNull());
                await screen.pressByTestIdAsync('machine-share-grant-account:bob');
                await screen.pressByTestIdAsync(`machine-share-level:account:bob:${level}`);
            }
            await vi.waitFor(() => expect(home.requests.filter(request => request.method === 'PUT')).toHaveLength(1));
            expect(home.requests.filter(request => request.method === 'PUT').map(request => request.body)).toEqual([{ principal: bob, level }]);
            if (scenario === 'reduction') {
                await vi.waitFor(() => expect(screen.findByTestId('machine-share-level:account:bob:view')?.props.disabled).toBe(false));
                expect(Modal.confirm).not.toHaveBeenCalled();
                return;
            }
            await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalledTimes(1));
            const [title, message] = vi.mocked(Modal.confirm).mock.calls[0]!;
            expect(title).toContain('Devbox');
            expect(message).toContain('Bob');
            expect(message).toContain(t(level === 'admin' ? 'machines.sharing.manage' : 'machines.sharing.use'));
        } finally { await home.dispose(); }
    });

    it.each([false, null])('shows an offline recipient notice only for observed offline presence (%s)', async online => {
        const snapshot: MachineAccessGrantsListResponseV1 = { ...initial, canManage: false, grants: [], ownDirectGrant: false,
            access: { ...initial.access, role: 'use' }, ownAccessSources: [{ principal: { kind: 'team', teamId: 'team' }, displayName: 'Teammates' }] };
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-recipient.test', accountId: 'bob' }],
            route: request => request.path === '/v1/machines/machine/access' && request.method === 'GET' ? Response.json(snapshot) : undefined });
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: 'bob' };
            function Surface() {
                const controller = useMachineShareController({ machineId: 'machine', machineName: 'Devbox', scope });
                return <ShareSheet model={controller.model} actions={controller.actions}
                    adapter={createMachineShareAdapter({ machineName: 'Devbox', online, controller })}
                    presentation="full" testID="machine-share-editor" />;
            }
            const screen = await renderScreen(<Surface />);
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-your-access')).not.toBeNull());
            const text = screen.getTextContent();
            if (online === false) expect(text).toContain(t('machines.sharing.offlineRecipient', { machine: 'Devbox' }));
            else expect(text).not.toContain(t('machines.sharing.offlineRecipient', { machine: 'Devbox' }));
            expect(text).not.toContain(t('machines.sharing.offline', { machine: 'Devbox' }));
            expect(screen.findByTestId('machine-share-your-access-visual')).not.toBeNull();
        } finally { await home.dispose(); }
    });

    it('retries waived Leave after failure and discloses overlapping inherited access without exposing a manager roster', async () => {
        let failLeave = true;
        let snapshot: MachineAccessGrantsListResponseV1 = { ...initial, canManage: false, grants: [], ownDirectGrant: true,
            access: { ...initial.access, role: 'use' }, ownAccessSources: [
                { principal: bob, displayName: 'Bob' }, { principal: { kind: 'team', teamId: 'team' }, displayName: 'Teammates' },
            ] };
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-leave.test', accountId: 'bob', settings: {
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.access.leave': ['ui'] } },
        } }], route: request => {
            if (request.path !== '/v1/machines/machine/access') return undefined;
            if (request.method === 'GET') return Response.json(snapshot);
            if (request.method === 'DELETE') {
                if (failLeave) return Response.json({ kind: 'refused', code: 'machine_unavailable' }, { status: 503 });
                snapshot = { ...snapshot, ownDirectGrant: false, ownAccessSources: snapshot.ownAccessSources.filter(source => source.principal.kind !== 'account') };
                return Response.json({ kind: 'left', effectiveAccess: 'use' });
            }
            return undefined;
        } });
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: 'bob' };
            function Surface() {
                const controller = useMachineShareController({ machineId: 'machine', machineName: 'Devbox', scope });
                return <ShareSheet model={controller.model} actions={controller.actions}
                    adapter={createMachineShareAdapter({ machineName: 'Devbox', online: true, controller })}
                    presentation="full" testID="machine-share-editor" />;
            }
            const screen = await renderScreen(<Surface />);
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-your-access')).not.toBeNull());
            // Someone it is shared with reads whose operating-system user their work runs as, not the owner's
            // exposure warning, and no Manage legend they cannot give; their access names the Team it comes through.
            const text = screen.getTextContent();
            expect(text).toContain(t('machines.sharing.recipientTrustLead', { machine: 'Devbox' }));
            expect(text).not.toContain(t('machines.sharing.trustedOsLead', { machine: 'Devbox' }));
            await screen.pressByTestIdAsync('machine-share-help');
            expect(screen.getTextContent()).toContain(t('machines.sharing.recipientTrustDetail', { machine: 'Devbox' }));
            expect(screen.getTextContent()).not.toContain(t('machines.sharing.manageHelp', { machine: 'Devbox' }));
            expect(text).toContain(t('machines.sharing.through', { audience: 'Teammates' }));
            await screen.pressByTestIdAsync('machine-share-your-access');
            await screen.pressByTestIdAsync('machine-share-remove:account:bob');
            expect(screen.findByTestId('machine-share-remove-consequence:account:bob')?.props.children).toBe(t('machines.sharing.overlap'));
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-retry:account:bob')).not.toBeNull());
            expect(screen.findByTestId('machine-share-remove-confirm:account:bob')).toBeNull();
            failLeave = false;
            await screen.pressByTestIdAsync('machine-share-retry:account:bob');
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-remove-reason:account:bob')).not.toBeNull());
            expect(screen.findByTestId('machine-share-remove:account:bob')).toBeNull();
            expect(screen.findByTestId('machine-share-grant-account:bob')).toBeNull();
            expect(home.requests.filter(request => request.method === 'DELETE').map(request => request.body)).toEqual([{}, {}]);
            expect(home.requests.filter(request => request.path.includes('data-key-envelopes'))).toEqual([]);
        } finally { await home.dispose(); }
    });

    it('locks an incompatible directory candidate only after the typed Home refusal, retaining the query and exact target', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'machine', serverUrl: 'https://machine-refusal.test', accountId: 'alice', settings: {
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.access.grant.set': ['ui'] } },
        } }], route: request => {
            if (request.path === '/v1/user/search') return Response.json({ users: [{
                id: 'bob', username: 'bob', firstName: 'Bob', lastName: null, avatar: null, bio: null,
                status: 'none', publicKey: null,
            }], nextCursor: null });
            if (request.path !== '/v1/machines/machine/access') return undefined;
            if (request.method === 'GET') return Response.json({ ...initial, grants: [] });
            // Mode may have changed after the earlier list. Identity discovery is not mode authority.
            if (request.method === 'PUT') return Response.json({ kind: 'refused', code: 'recipient_encryption_incompatible' }, { status: 409 });
            return undefined;
        } });
        try {
            const scope = { serverId: home.homes.machine!.id, accountId: 'alice' };
            function Surface() {
                const controller = useMachineShareController({ machineId: 'machine', machineName: 'Devbox', scope });
                return <ShareSheet model={controller.model} actions={controller.actions}
                    adapter={createMachineShareAdapter({ machineName: 'Devbox', online: true, controller })}
                    presentation="full" testID="machine-share-editor" />;
            }
            const screen = await renderScreen(<Surface />);
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-search')).not.toBeNull());
            screen.changeTextByTestId('machine-share-search', 'Bob');
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-candidate-account:bob')).not.toBeNull());
            await screen.pressByTestIdAsync('machine-share-candidate-account:bob');
            await vi.waitFor(() => expect(home.requests.filter(request => request.method === 'PUT')).toHaveLength(1));
            await vi.waitFor(() => expect(screen.findAll(node => typeof node.props.children === 'string'
                && node.props.children.includes(t('machines.sharing.incompatible', { machine: 'Devbox', person: 'Bob' })))).not.toHaveLength(0));
            await screen.pressByTestIdAsync('machine-share-candidate-account:bob');
            expect(home.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
            expect(screen.findByTestId('machine-share-search')?.props.value).toBe('Bob');
            expect(screen.findByTestId('machine-share-grant-account:bob')).toBeNull();
        } finally { await home.dispose(); }
    });
});
