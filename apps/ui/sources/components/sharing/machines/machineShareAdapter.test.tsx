import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { MachineAccessGrantsListResponseV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { renderScreen } from '@/dev/testkit';
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
    return createModalModuleMock({ spies: { confirm: vi.fn(async () => true) } }).module;
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
        } finally { home.dispose(); }
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
        } finally { home.dispose(); localStorage.restore(); }
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
        } finally { home.dispose(); }
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
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-level:team:team:admin')?.props.accessibilityState.selected).toBe(true));
            expect(home.requests.filter(request => request.path.includes('data-key-envelopes'))).toEqual([]);
            // A later eligible joiner is recoverable even while Cara remains incompatible.
            snapshot = { ...snapshot, grants: snapshot.grants.map(row => ({ ...row, audience: [
                ...row.audience, { accountId: 'dana', displayName: 'Dana', readiness: 'key_pending', reason: 'recipient_key_pending', canPrepareKeys: true },
            ] })) };
            await act(async () => { publishHomeAccountChange(scope.serverId, ['machine']); });
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-key-retry:team:team')).not.toBeNull());
            expect(screen.findByTestId('machine-share-incompatible:team:team:cara')).not.toBeNull();
        } finally { home.dispose(); }
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
            const screen = await renderScreen(<React.StrictMode><Surface /></React.StrictMode>);
            // Prove this renderer actually replayed setup/cleanup; a StrictMode wrapper alone is insufficient.
            expect(setups.map(setup => setup.retired)).toEqual([true, false]);
            await vi.waitFor(() => expect(requests.some(request => request.signal?.aborted === false)).toBe(true));
            const current = requests.findLast(request => request.signal?.aborted === false)!;
            await act(async () => { current.finish(Response.json(initial)); });
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-grant-account:bob')).not.toBeNull());
            await act(async () => { publishHomeAccountChange(scope.serverId, ['machine']); });
            const pending = requests.findLast(request => request !== current && request.signal?.aborted === false);
            expect(pending).toBeDefined();
            await screen.unmount();
            expect(setups.every(setup => setup.retired)).toBe(true);
            expect(pending?.signal?.aborted).toBe(true);
            expect(requests.filter(request => request !== current).every(request => request.signal?.aborted === true)).toBe(true);
            await act(async () => {
                for (const request of requests) request.finish(Response.json({ ...initial, grants: [] }));
            });
        } finally { home.dispose(); }
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
            expect(screen.findByTestId('machine-share-level:account:bob:admin')?.props.accessibilityState.selected).toBe(true);
            expect(home.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
        } finally { home.dispose(); }
    });
    it('offers Use and Manage, retains the exact failed level intent, and confirms effective loss in the same row', async () => {
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
            expect(screen.findByTestId('machine-share-level:account:bob:admin')?.props.accessibilityState.selected).toBe(true);
            failSave = false;
            await screen.pressByTestIdAsync('machine-share-retry:account:bob');
            await vi.waitFor(() => {
                expect(writes).toHaveLength(2);
                expect(screen.findByTestId('machine-share-level:account:bob:admin')?.props.disabled).toBe(false);
            });
            expect(screen.findByTestId('machine-share-retry:account:bob')).toBeNull();
            expect(screen.findByTestId('machine-share-search')?.props.value).toBe('Bob');
            expect(writes).toEqual([{ principal: bob, level: 'admin' }, { principal: bob, level: 'admin' }]);
            await screen.pressByTestIdAsync('machine-share-remove:account:bob');
            expect(screen.findByTestId('machine-share-remove-consequence:account:bob')?.props.children).toBe(`Bob: ${t('machines.sharing.effectiveLoss')}`);
            expect(screen.findByTestId('machine-share-trusted-os')).not.toBeNull();
            await screen.pressByTestIdAsync('machine-share-remove-cancel:account:bob');
            expect(screen.findByTestId('machine-share-remove-confirm:account:bob')).toBeNull();
            expect(screen.findByTestId('machine-share-remove:account:bob')).not.toBeNull();
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-browse:team')).not.toBeNull());
            await screen.pressByTestIdAsync('machine-share-browse:team');
            expect(screen.findByTestId('machine-share-trusted-os')).not.toBeNull();
            await screen.pressByTestIdAsync('machine-share-editor:list:header:leading:back-chip');
            expect(screen.findByTestId('machine-share-search')?.props.value).toBe('Bob');
            expect(screen.findByTestId('machine-share-remove:account:bob')).not.toBeNull();
        } finally { home.dispose(); }
    });

    it('keeps Leave confirmation after failure and acknowledges overlapping inherited access without exposing a manager roster', async () => {
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
            await screen.pressByTestIdAsync('machine-share-your-access');
            await screen.pressByTestIdAsync('machine-share-remove:account:bob');
            expect(screen.findByTestId('machine-share-remove-consequence:account:bob')?.props.children).toBe(t('machines.sharing.overlap'));
            await screen.pressByTestIdAsync('machine-share-remove-confirm:account:bob');
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-retry:account:bob')).not.toBeNull());
            expect(screen.findByTestId('machine-share-remove-cancel:account:bob')).not.toBeNull();
            failLeave = false;
            await screen.pressByTestIdAsync('machine-share-retry:account:bob');
            await vi.waitFor(() => expect(screen.findByTestId('machine-share-remove-reason:account:bob')).not.toBeNull());
            expect(screen.findByTestId('machine-share-remove:account:bob')).toBeNull();
            expect(screen.findByTestId('machine-share-grant-account:bob')).toBeNull();
            expect(home.requests.filter(request => request.method === 'DELETE').map(request => request.body)).toEqual([{}, {}]);
            expect(home.requests.filter(request => request.path.includes('data-key-envelopes'))).toEqual([]);
        } finally { home.dispose(); }
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
        } finally { home.dispose(); }
    });
});
