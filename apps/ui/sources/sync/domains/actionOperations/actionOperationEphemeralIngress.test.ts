import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';

vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

import { ActionOperationSnapshotV1Schema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol';
import { ACTION_OPERATION_RPC_METHODS_V2, projectActionOperationSnapshotForV1Reader } from '@happier-dev/protocol/actions/operations/v1';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { getActionOperation, type ActionOperationRpc } from '@/sync/ops/actionOperations';

import { createActionOperationStore } from './actionOperationStore';
import { consumeActionOperationSnapshotPush } from './consumeActionOperationSnapshotPush';
import { normalizeActionOperationEphemeralIngress } from './actionOperationEphemeralIngress';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';

describe('normalizeActionOperationEphemeralIngress', () => {
    it('observes keyless Plain Script revisions on a selected secondary Home through its real cache socket', async () => {
        let secondarySocket: Socket | undefined;
        const snapshot: ActionOperationSnapshotV1 = { version: 1, operationId: 'secondary-plain-script', revision: 1,
            actionId: 'projects.script.run', state: 'accepted', scope: { accountId: 'secondary-account', machineId: 'machine-1' },
            title: 'Run Script', createdAt: 1, cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'script',
                serverId: 'source-home', machineId: 'worker', workspaceRefId: 'target', cwd: '/target',
                sourceWorkspace: { serverId: 'source-home', machineId: 'source', workspaceId: 'source', rootPath: '/source' },
                script: { name: 'check', source: { kind: 'command', command: 'check' } } } };
        let rpcSnapshot = snapshot;
        let holdGet = false;
        let getStarted: (() => void) | undefined;
        let releaseGet: (() => void) | undefined;
        const startedGet = new Promise<void>(resolve => { getStarted = resolve; });
        const heldGet = new Promise<void>(resolve => { releaseGet = resolve; });
        installDisconnectedServerSocketBoundary((socket, serverUrl) => {
            socket.connected = true;
            if (serverUrl === 'https://secondary-operation.test') secondarySocket = socket;
            socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, request: SocketRpcRequestPayload) => {
                if (event !== SOCKET_RPC_EVENTS.CALL) throw new Error(`Unexpected socket event: ${event}`);
                if (request.method === `machine-1:${ACTION_OPERATION_RPC_METHODS_V2.get}`) {
                    if (holdGet) { getStarted?.(); await heldGet; }
                    return { ok: true, result: { kind: 'found', operation: rpcSnapshot } };
                }
                if (request.method.endsWith(ACTION_OPERATION_RPC_METHODS_V2.list)) return { ok: true, result: { operations: [] } };
                throw new Error(`Unexpected Machine method: ${request.method}`);
            });
        });
        const bridge = await loadSyncSingletonForTests();
        const homes = await serveAccountHomes({ homes: [
            { key: 'inactive', serverUrl: 'https://inactive-operation.test', accountId: 'inactive-account' },
            { key: 'secondary', serverUrl: 'https://secondary-operation.test', accountId: 'secondary-account' },
            { key: 'focused', serverUrl: 'https://focused-operation.test', accountId: 'focused-account' },
        ], route: request => {
            if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (request.path === '/v1/machines/machine-1') return Response.json({ machine: {
                id: 'machine-1', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            } });
            return undefined;
        } });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
        const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
        const { actionOperationStore } = await import('./actionOperationStore');
        try {
            const credentials = await TokenStorage.getCredentialsForServerUrl(homes.homes.focused!.serverUrl);
            if (!credentials) throw new Error('Focused Home credential fixture missing');
            await restoreConnectionToActiveServer(credentials);
            await updateEffectiveHomeViewState(current => ({ ...current,
                groups: [{ id: 'operation-homes', name: 'Operation Homes', serverIds: [homes.homes.focused!.id, homes.homes.secondary!.id] }],
                activeTargetKind: 'group', activeTargetId: 'operation-homes',
            }), { scope: 'device' });
            startConcurrentSessionCacheSync();
            await vi.waitFor(() => expect(secondarySocket?.listeners('ephemeral').length).toBeGreaterThan(0));
            // The qualified read opens another socket at this URL. Retain the
            // actual managed ingress transport before that RPC can replace the boundary variable.
            const originalSocket = secondarySocket!;
            actionOperationStore.reset();
            for (const listener of originalSocket.listeners('ephemeral')) listener({
                type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'plain', v: snapshot },
            });
            await vi.waitFor(() => expect([...actionOperationStore.getSnapshot().operationsByKey.values()])
                .toEqual([{ serverId: homes.homes.secondary!.id, snapshot }]));
            rpcSnapshot = { ...snapshot, operationId: 'secondary-retired-script' };
            holdGet = true;
            for (const listener of originalSocket.listeners('ephemeral')) listener({
                type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'plain', v: rpcSnapshot },
            });
            await startedGet;
            homes.switchAccount('inactive', 'replacement-inactive-account');
            const inactiveReplacement = await TokenStorage.getCredentialsForServerUrl(homes.homes.inactive!.serverUrl);
            if (!inactiveReplacement) throw new Error('Replacement inactive Account credential fixture missing');
            expect(await TokenStorage.setCredentialsForServerUrl(homes.homes.inactive!.serverUrl,
                { serverId: homes.homes.inactive!.id }, inactiveReplacement)).toBe(true);
            expect(originalSocket.connected).toBe(true);
            homes.switchAccount('secondary', 'replacement-secondary-account');
            const replacement = await TokenStorage.getCredentialsForServerUrl(homes.homes.secondary!.serverUrl);
            if (!replacement) throw new Error('Replacement secondary Account credential fixture missing');
            expect(await TokenStorage.setCredentialsForServerUrl(homes.homes.secondary!.serverUrl,
                { serverId: homes.homes.secondary!.id }, replacement)).toBe(true);
            // Release before asynchronous cache reconciliation can replace the entry:
            // the stored Account mutation itself must retire this response's interest.
            releaseGet?.();
            await heldGet; await flushHookEffects();
            expect([...actionOperationStore.getSnapshot().operationsByKey.values()]
                .some(operation => operation.snapshot.operationId === 'secondary-retired-script')).toBe(false);
        } finally {
            releaseGet?.();
            stopConcurrentSessionCacheSync();
            await disconnectActiveServerConnection();
            await updateEffectiveHomeViewState(current => ({ ...current, groups: [], activeTargetKind: 'server',
                activeTargetId: homes.homes.focused!.id }), { scope: 'device' });
            homes.dispose(); bridge.dispose(); actionOperationStore.reset(); installDisconnectedServerSocketBoundary();
        }
    });
    it('observes keyless Plain Script updates through the restored Sync socket and drops retired Account interest', async () => {
        const sockets: Socket[] = [];
        const snapshot: ActionOperationSnapshotV1 = { version: 1, operationId: 'plain-restored-script', revision: 1,
            actionId: 'projects.script.run', state: 'accepted', scope: { accountId: 'plain-restored-account', machineId: 'machine-1' },
            title: 'Run Script', createdAt: 1, cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'script',
                serverId: 'source-home', machineId: 'worker', workspaceRefId: 'target', cwd: '/target',
                sourceWorkspace: { serverId: 'source-home', machineId: 'source', workspaceId: 'source', rootPath: '/source' },
                script: { name: 'check', source: { kind: 'command', command: 'check' } } } };
        let rpcSnapshot = snapshot;
        installDisconnectedServerSocketBoundary(socket => {
            socket.connected = true;
            sockets.push(socket);
            socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, request: SocketRpcRequestPayload) => {
                if (event !== SOCKET_RPC_EVENTS.CALL) throw new Error(`Unexpected socket event: ${event}`);
                if (request.method === `machine-1:${ACTION_OPERATION_RPC_METHODS_V2.get}`)
                    return { ok: true, result: { kind: 'found', operation: rpcSnapshot } };
                if (request.method.endsWith(ACTION_OPERATION_RPC_METHODS_V2.list))
                    return { ok: true, result: { operations: [] } };
                throw new Error(`Unexpected Machine method: ${request.method}`);
            });
        });
        const bridge = await loadSyncSingletonForTests();
        let releaseMode: (() => void) | undefined;
        let modeStarted: (() => void) | undefined;
        let holdMode = false;
        const started = new Promise<void>(resolve => { modeStarted = resolve; });
        const heldMode = new Promise<void>(resolve => { releaseMode = resolve; });
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://plain-operation-restored.test',
            accountId: 'plain-restored-account', request: async (url) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') {
                    if (holdMode) { modeStarted?.(); await heldMode; }
                    return Response.json({ mode: 'plain', updatedAt: 1 });
                }
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/machines/machine-1') return Response.json({ machine: {
                    id: 'machine-1', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                } });
                return Response.json({ error: 'not_found' }, { status: 404 });
            } });
        const { actionOperationStore } = await import('./actionOperationStore');
        actionOperationStore.reset();
        const deliver = (value: ActionOperationSnapshotV1) => {
            rpcSnapshot = value;
            const update = { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'plain', v: value } };
            for (const listener of sockets[0]!.listenersAny()) listener('ephemeral', update);
        };
        try {
            expect(connection.credentials).toEqual({ token: expect.any(String) });
            expect(sockets[0]!.listenersAny().length).toBeGreaterThan(0);
            deliver(snapshot);
            await vi.waitFor(() => expect([...actionOperationStore.getSnapshot().operationsByKey.values()])
                .toEqual([{ serverId: connection.home.id, snapshot }]));
            holdMode = true;
            deliver({ ...snapshot, operationId: 'late-retired-script' });
            await started;
            await connection.dispose();
            releaseMode?.();
            // Drain the released external response, not a timer or an internal Sync callback.
            await heldMode;
            await flushHookEffects();
            expect([...actionOperationStore.getSnapshot().operationsByKey.values()]
                .some(operation => operation.snapshot.operationId === 'late-retired-script')).toBe(false);
        } finally {
            releaseMode?.();
            await connection.dispose(); bridge.dispose(); actionOperationStore.reset();
            installDisconnectedServerSocketBoundary();
        }
    });
    it('admits keyless Plain Script content through exact Account mode and the same qualified V2 reader', async () => {
        const snapshot: ActionOperationSnapshotV1 = {
            version: 1, operationId: 'plain-script', revision: 3, actionId: 'projects.script.run', state: 'failed',
            scope: { accountId: 'plain-account', machineId: 'machine-1' }, title: 'Run Script', createdAt: 1, startedAt: 2, settledAt: 7,
            cancellation: 'supported', error: { errorCode: 'project_command_step_failed', error: 'Command failed' },
            domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'original-home', machineId: 'worker',
                workspaceRefId: 'copied-target', cwd: '/target', terminalId: 'terminal', exitCode: 7,
                sourceWorkspace: { serverId: 'original-home', machineId: 'source', workspaceId: 'selected-source', rootPath: '/source' },
                script: { name: 'check', source: { kind: 'command', command: 'check' } } },
        };
        expect(ActionOperationSnapshotV1Schema.safeParse(snapshot)).toMatchObject({ success: true });
        const raw = { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'plain', v: projectActionOperationSnapshotForV1Reader(snapshot) } };
        const update = normalizeActionOperationEphemeralIngress(raw);
        expect(update).toEqual(raw);
        if (!update) return;
        let mode: 'plain' | 'e2ee' = 'plain';
        const readMode = async () => (await fetchAccountEncryptionMode({ token: 'plain-account-token' }, {
            // Exact-Home HTTP is the boundary; persisted-mode parser and consumer remain real.
            request: async path => {
                expect(path).toBe('/v1/account/encryption');
                return new Response(JSON.stringify({ mode, updatedAt: 1 }), { status: 200 });
            },
        })).mode;
        const requests: Parameters<ActionOperationRpc>[0][] = [];
        // External Machine RPC boundary; the qualified V2 reader and parser remain real.
        const rpc = (async (request: Parameters<ActionOperationRpc>[0]) => {
            requests.push(request);
            return { kind: 'found', operation: snapshot };
        }) as ActionOperationRpc;
        const consume = async (accountId: string, current = true) => {
            const store = createActionOperationStore();
            await consumeActionOperationSnapshotPush({ update, accountId, sourceServerId: 'original-home',
                accountEncryptionMode: await readMode(), store, shouldContinue: () => current,
                readSnapshot: operationId => getActionOperation({ serverId: 'original-home', accountId,
                    machineId: 'machine-1', operationId, requireCurrentDomainFacts: true, rpc }),
            });
            return store.getSnapshot();
        };
        expect([...(await consume('plain-account')).operationsByKey.values()]).toEqual([{ serverId: 'original-home', snapshot }]);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({ serverId: 'original-home', accountId: 'plain-account', machineId: 'machine-1', method: ACTION_OPERATION_RPC_METHODS_V2.get });
        mode = 'e2ee';
        expect((await consume('plain-account')).operationsByKey.size).toBe(0);
        mode = 'plain';
        expect((await consume('replacement-account')).operationsByKey.size).toBe(0);
        expect((await consume('plain-account', false)).operationsByKey.size).toBe(0);
        expect(requests).toHaveLength(1);
    });
    it.each([
        [
            'released 0.2.11 envelope',
            {
                type: 'action-operation-updated',
                machineId: 'machine-1',
                content: { t: 'encrypted', c: 'sealed' },
            },
        ],
        [
            'pre-release current-dev drain envelope',
            {
                type: 'action-operation-snapshot',
                machineId: 'machine-1',
                ciphertext: 'sealed',
            },
        ],
    ])('normalizes the %s through one qualified-store ingress', (_name, raw) => {
        expect(normalizeActionOperationEphemeralIngress(raw)).toStrictEqual({
            type: 'action-operation-updated',
            machineId: 'machine-1',
            content: { t: 'encrypted', c: 'sealed' },
        });
    });

    it('rejects unqualified or malformed legacy input', () => {
        expect(normalizeActionOperationEphemeralIngress({
            type: 'action-operation-updated',
            machineId: 'machine-1',
            content: { t: 'plain', v: 'sealed' },
        })).toBeNull();
        expect(normalizeActionOperationEphemeralIngress({
            type: 'action-operation-updated',
            content: { t: 'encrypted', c: 'sealed' },
        })).toBeNull();
    });

    it('attaches the immutable authenticated Home rather than any focused Home', async () => {
        const store = createActionOperationStore();
        const snapshot: ActionOperationSnapshotV1 = {
            version: 1,
            operationId: 'operation-1',
            revision: 1,
            actionId: 'session.spawn_new',
            state: 'running',
            scope: { accountId: 'account-b', machineId: 'machine-1' },
            title: 'Create session',
            createdAt: 1,
            startedAt: 2,
            cancellation: 'supported',
        };

        const update = normalizeActionOperationEphemeralIngress({
            type: 'action-operation-updated',
            machineId: 'machine-1',
            content: { t: 'encrypted', c: 'sealed' },
        });
        expect(update).not.toBeNull();
        if (!update) return;

        // The inspected ../0.2 daemon only registers V1; its RPC owner returns this typed refusal for V2.
        const rpc: ActionOperationRpc = async () => {
            throw new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND);
        };
        const params = {
            update,
            accountId: 'account-b',
            accountEncryptionMode: 'e2ee' as const,
            sourceServerId: 'home-b',
            openSnapshot: () => snapshot,
            store,
            readSnapshot: (operationId: string) => getActionOperation({
                ...{ accountId: 'account-b', requireCurrentDomainFacts: true as const }, serverId: 'home-b', machineId: 'machine-1', operationId, rpc,
            }),
        };
        await consumeActionOperationSnapshotPush(params);

        expect([...store.getSnapshot().operationsByKey.values()]).toStrictEqual([{
            serverId: 'home-b',
            snapshot,
        }]);
    });

    it('uses the qualified current reader before merging a compatibility-projected notification', async () => {
        const store = createActionOperationStore();
        const base: ActionOperationSnapshotV1 = {
            version: 1, operationId: 'operation-managed', revision: 2,
            actionId: 'machines.managed.acquire', state: 'accepted',
            scope: { accountId: 'account-b', machineId: 'machine-1' },
            title: 'Acquire machine', createdAt: 1, cancellation: 'supported',
        };
        const setupReview = {
            kind: 'pendingApproval', code: 'project_setup_consent_required',
            reviewedEffectDigest: 'reviewed-effect', reviewedEffect: { commands: ['install'] },
        } as const;
        const projectCommand = {
            kind: 'projectCommand', purpose: 'script', serverId: 'home-b', machineId: 'machine-1',
            workspaceRefId: 'workspace-1', cwd: '/project',
        } as const;
        const richSnapshots: ActionOperationSnapshotV1[] = [
            { ...base, domainRef: { kind: 'managedMachine', id: 'managed-row',
                bootstrapTask: { id: 'real-task', taskKind: 'remote.ssh.bootstrapMachine.v1' } } },
            { ...base, operationId: 'operation-review', actionId: 'projects.script.run',
                domainRef: projectCommand, setupReview },
            { ...base, operationId: 'operation-failure', actionId: 'projects.script.run',
                state: 'failed', startedAt: 2, settledAt: 3, domainRef: projectCommand,
                error: { errorCode: setupReview.code, error: 'Consent required', details: setupReview } },
        ].map(snapshot => ActionOperationSnapshotV1Schema.parse(snapshot));
        const observed: ActionOperationSnapshotV1[] = [];
        // The RPC is the Machine process boundary; the V2 parser and qualified store stay real.
        const rpc: ActionOperationRpc = (async (request: Parameters<ActionOperationRpc>[0]) => {
            expect(request).toMatchObject({ serverId: 'home-b', accountId: 'account-b',
                machineId: 'machine-1', method: ACTION_OPERATION_RPC_METHODS_V2.get });
            const operationId = (request.payload as Readonly<{ operationId: string }>).operationId;
            return { kind: 'found', operation: richSnapshots.find(item => item.operationId === operationId) };
        }) as ActionOperationRpc;

        for (const rich of richSnapshots) {
            store.mergeSnapshots({ serverId: 'home-b', snapshots: [{ ...rich, revision: 1 }] });
            // Current publisher's released-reader projection omits these owner-only facts.
            const notification = projectActionOperationSnapshotForV1Reader(rich);
            const params = {
                update: { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'encrypted', c: 'sealed' } } as const,
                accountEncryptionMode: 'e2ee' as const,
                accountId: 'account-b', sourceServerId: 'home-b', store,
                openSnapshot: () => notification,
                readSnapshot: (operationId: string) => getActionOperation({
                    ...{ accountId: 'account-b', requireCurrentDomainFacts: true as const }, serverId: 'home-b', machineId: 'machine-1', operationId, rpc,
                }),
                onSnapshot: (operation: Readonly<{ snapshot: ActionOperationSnapshotV1 }>) => {
                    observed.push(operation.snapshot);
                },
            };
            await consumeActionOperationSnapshotPush(params);
        }

        expect([...store.getSnapshot().operationsByKey.values()]).toStrictEqual(
            richSnapshots.map(snapshot => ({ serverId: 'home-b', snapshot })),
        );
        expect(observed).toStrictEqual(richSnapshots);
    });

    it.each([RPC_ERROR_CODES.METHOD_NOT_FOUND, RPC_ERROR_CODES.FORBIDDEN])(
        'does not erase retained rich facts when the qualified read fails with %s', async (code) => {
            const store = createActionOperationStore();
            const retained: ActionOperationSnapshotV1 = {
                version: 1, operationId: 'operation-1', revision: 1,
                actionId: 'machines.managed.acquire', state: 'accepted',
                scope: { accountId: 'account-b', machineId: 'machine-1' },
                title: 'Acquire machine', createdAt: 1, cancellation: 'supported',
                domainRef: { kind: 'managedMachine', id: 'managed-row' },
            };
            store.mergeSnapshots({ serverId: 'home-b', snapshots: [retained] });
            const { domainRef: _ref, ...common } = retained;
            const rpc: ActionOperationRpc = async () => { throw new RpcError('Read refused', code); };
            const params = {
                update: { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'encrypted', c: 'sealed' } } as const,
                accountEncryptionMode: 'e2ee' as const,
                accountId: 'account-b', sourceServerId: 'home-b', store,
                openSnapshot: () => ({ ...common, revision: 2 }),
                readSnapshot: (operationId: string) => getActionOperation({
                    ...{ accountId: 'account-b', requireCurrentDomainFacts: true as const }, serverId: 'home-b', machineId: 'machine-1', operationId, rpc,
                }),
            };
            await consumeActionOperationSnapshotPush(params);
            expect([...store.getSnapshot().operationsByKey.values()]).toStrictEqual([
                { serverId: 'home-b', snapshot: retained },
            ]);
            expect([...store.getSnapshot().machineObservationByKey.values()]).toEqual(['unavailable']);
        },
    );

    it('drops a late qualified read after the captured Home and Account lifetime retires', async () => {
        const store = createActionOperationStore();
        const snapshot: ActionOperationSnapshotV1 = {
            version: 1, operationId: 'operation-1', revision: 1,
            actionId: 'session.spawn_new', state: 'accepted',
            scope: { accountId: 'account-b', machineId: 'machine-1' },
            title: 'Create session', createdAt: 1, cancellation: 'supported',
        };
        let current = true;
        let completeRead: (value: unknown) => void = () => {};
        let readStarted: () => void = () => {};
        const started = new Promise<void>(resolve => { readStarted = resolve; });
        const rpc = (async () => {
            readStarted();
            return new Promise<unknown>(resolve => { completeRead = resolve; });
        }) as ActionOperationRpc;
        const params = {
            update: { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'encrypted', c: 'sealed' } } as const,
            accountEncryptionMode: 'e2ee' as const,
            accountId: 'account-b', sourceServerId: 'home-b', store,
            openSnapshot: () => snapshot,
            shouldContinue: () => current,
            readSnapshot: (operationId: string) => getActionOperation({
                ...{ accountId: 'account-b', requireCurrentDomainFacts: true as const }, serverId: 'home-b', machineId: 'machine-1', operationId, rpc,
            }),
        };
        const consuming = consumeActionOperationSnapshotPush(params);
        // A premature direct merge also settles here, producing the same observable failure.
        await Promise.race([started, consuming]);
        current = false;
        completeRead({ kind: 'found', operation: snapshot });
        await consuming;
        expect(store.getSnapshot().operationsByKey.size).toBe(0);
        expect(store.getSnapshot().machineObservationByKey.size).toBe(0);
    });

    it('does not disclose a qualified-read reply belonging to another Account', async () => {
        const store = createActionOperationStore();
        const snapshot: ActionOperationSnapshotV1 = {
            version: 1, operationId: 'operation-1', revision: 1,
            actionId: 'session.spawn_new', state: 'accepted',
            scope: { accountId: 'account-b', machineId: 'machine-1' },
            title: 'Create session', createdAt: 1, cancellation: 'supported',
        };
        const rpc = (async () => ({ kind: 'found', operation: {
            ...snapshot, scope: { ...snapshot.scope, accountId: 'account-a' },
        } })) as ActionOperationRpc;
        const params = {
            update: { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'encrypted', c: 'sealed' } } as const,
            accountEncryptionMode: 'e2ee' as const,
            accountId: 'account-b', sourceServerId: 'home-b', store,
            openSnapshot: () => snapshot,
            readSnapshot: (operationId: string) => getActionOperation({
                ...{ accountId: 'account-b', requireCurrentDomainFacts: true as const }, serverId: 'home-b', machineId: 'machine-1', operationId, rpc,
            }),
        };
        await consumeActionOperationSnapshotPush(params);
        expect(store.getSnapshot().operationsByKey.size).toBe(0);
    });
});
