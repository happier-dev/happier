import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Socket } from 'socket.io-client';
import { afterEach, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ paths: [] as string[], active: new Set<import('node:fs').FSWatcher>(), failurePath: '' }));
// Instrument the genuine OS watch boundary while retaining native delivery and traversal.
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, watch: (path: string, options: import('node:fs').WatchOptionsWithStringEncoding,
        listener: import('node:fs').WatchListener<string>) => {
        boundary.paths.push(path);
        if (path === boundary.failurePath) throw Object.assign(new Error('Native watch capacity exhausted'), { code: 'ENOSPC' });
        const watcher = actual.watch(path, options, listener);
        boundary.active.add(watcher);
        watcher.once('close', () => boundary.active.delete(watcher));
        return watcher;
    } };
});
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createTestGitScmBackendRegistry } from '@/scm/rpc/__tests__/testRpcHarness';
import { registerScmHandlers } from './scm';

const watchMethod = 'scm.workspace.watch.v1';
afterEach(() => { boundary.paths = []; boundary.failurePath = ''; });

it('parks admitted demand, refreshes cached status after native changes and releases the shared watch on cancellation', async () => {
    await withTempDir('scm-watch-rpc-', async directory => {
        await promisify(execFile)('git', ['init', '-q', directory]);
        await writeFile(join(directory, 'file.txt'), 'before');
        const machineId = 'machine-scm';
        const rpc = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId, encryptionMode: 'plain', logger() {},
            authorizeRequest: request => authorizeMachineRpcRequest(request, {
                machineId, resolveCustodianAccountId: async () => 'custodian', resolveInstallationId: () => 'installation',
                resolveHomeServerIdentityId: async () => 'home',
                // Home is the genuine external authorization boundary.
                verifyMachineAdmission: async () => true,
            }) });
        registerScmHandlers(rpc, directory, { machineId, registry: createTestGitScmBackendRegistry() });
        const socket = Object.assign(new EventEmitter(), { connected: true }) as unknown as Socket;
        rpc.onSocketConnect(socket);
        const machineAdmission = { actorAccountId: 'custodian', custodianAccountId: 'custodian', machineId,
            installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const };
        const call = (params: unknown, requestId: string) => rpc.handleRequest({ method: `${machineId}:${watchMethod}`,
            machineAdmission, callerAuthority: 'present_user', requestId, params });
        let observationSettled = false;
        const observation = call({ directory, observationOnly: true }, 'observation').then(result => { observationSettled = true; return result; });
        const ready = await call({ directory }, 'initial');
        let peerObservation: Promise<unknown> | undefined;
        try {
            expect(ready).toMatchObject({ status: 'ready', revision: expect.any(Number) });
            expect(observationSettled).toBe(false);
            const attachedCount = boundary.paths.length;
            expect(attachedCount).toBeGreaterThan(0);
            peerObservation = call({ directory, observationOnly: true }, 'peer-observation');
            expect(await call({ directory }, 'peer-initial')).toMatchObject({ status: 'ready' });
            expect(boundary.paths).toHaveLength(attachedCount);
            // Freeze only the clock boundary: native events stay real and the
            // cache cannot pass this test merely by reaching its one-second TTL.
            vi.useFakeTimers({ toFake: ['Date'] });
            const readStatus = (requestId: string) => rpc.handleRequest({ method: `${machineId}:${RPC_METHODS.SCM_STATUS_SNAPSHOT}`,
                machineAdmission, callerAuthority: 'present_user', requestId, params: { cwd: directory } });
            expect(await readStatus('status-before')).toMatchObject({ success: true, snapshot: {
                entries: expect.arrayContaining([expect.objectContaining({ path: 'file.txt' })]),
            } });
            const revision = (ready as { revision: number }).revision;
            let changed: unknown;
            const waiting = call({ directory, sinceRevision: revision }, 'next').then(result => { changed = result; });
            await writeFile(join(directory, 'file.txt'), 'after');
            await writeFile(join(directory, 'external.txt'), 'new external file');
            await vi.waitFor(() => expect(changed).toMatchObject({ status: 'changed' }));
            await waiting;
            expect(await readStatus('status-after')).toMatchObject({ success: true, snapshot: {
                entries: expect.arrayContaining([expect.objectContaining({ path: 'external.txt' })]),
            } });
            expect(observationSettled).toBe(false);
            socket.emit(SOCKET_RPC_EVENTS.CANCEL, { requestId: 'observation' });
            await observation;
            expect(boundary.active.size).toBeGreaterThan(0);
        } finally {
            vi.useRealTimers();
            socket.emit(SOCKET_RPC_EVENTS.CANCEL, { requestId: 'observation' });
            socket.emit(SOCKET_RPC_EVENTS.CANCEL, { requestId: 'peer-observation' });
            socket.emit(SOCKET_RPC_EVENTS.CANCEL, { requestId: 'next' });
            await observation;
            await peerObservation;
        }
        await vi.waitFor(() => expect(boundary.active.size).toBe(0));
    });
});

it('preserves native watcher capacity refusal through the registered Machine handler', async () => {
    await withTempDir('scm-watch-unavailable-', async directory => {
        await promisify(execFile)('git', ['init', '-q', directory]);
        boundary.failurePath = await realpath(directory);
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger() {} });
        registerScmHandlers(rpc, directory, { machineId: 'machine', registry: createTestGitScmBackendRegistry() });
        expect(await rpc.invokeLocal(watchMethod, { directory })).toMatchObject({ status: 'unavailable', reason: { code: 'ENOSPC' } });
        await vi.waitFor(() => expect(boundary.active.size).toBe(0));
    });
});

it('invalidates cached status from before native watch enrollment', async () => {
    await withTempDir('scm-watch-enrollment-', async directory => {
        await promisify(execFile)('git', ['init', '-q', directory]);
        await writeFile(join(directory, 'before.txt'), 'before enrollment');
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger() {} });
        registerScmHandlers(rpc, directory, { machineId: 'machine', registry: createTestGitScmBackendRegistry() });
        vi.useFakeTimers({ toFake: ['Date'] });
        const controller = new AbortController();
        let observation: Promise<unknown> | undefined;
        try {
            expect(await rpc.invokeLocal(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: directory })).toMatchObject({ success: true,
                snapshot: { entries: expect.arrayContaining([expect.objectContaining({ path: 'before.txt' })]) } });
            await writeFile(join(directory, 'between.txt'), 'external edit before native demand');
            observation = rpc.invokeLocal(watchMethod, { directory, observationOnly: true }, { signal: controller.signal });
            expect(await rpc.invokeLocal(watchMethod, { directory })).toMatchObject({ status: 'ready' });
            expect(await rpc.invokeLocal(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: directory })).toMatchObject({ success: true,
                snapshot: { entries: expect.arrayContaining([expect.objectContaining({ path: 'between.txt' })]) } });
        } finally {
            controller.abort();
            await observation;
            vi.useRealTimers();
        }
        await vi.waitFor(() => expect(boundary.active.size).toBe(0));
    });
});

it('refuses a workspace outside the receiving Machine filesystem policy', async () => {
    await withTempDir('scm-watch-policy-', async directory => {
        const allowed = join(directory, 'allowed');
        const denied = join(directory, 'denied');
        await Promise.all([mkdir(allowed), mkdir(denied)]);
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger() {} });
        registerScmHandlers(rpc, allowed, { machineId: 'machine', accessPolicy: { kind: 'restrictedRoots', roots: [allowed] } });
        const result = await rpc.invokeLocal(watchMethod, { directory: denied });
        expect(result).toMatchObject({ status: 'unavailable', reason: { code: 'path_not_allowed' } });
    });
});
