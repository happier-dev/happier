import { Buffer } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { TerminalStreamReadRequestSchema } from '@happier-dev/protocol/terminal/stream';
import type { RpcHandler, RpcHandlerContext } from '../../../../apps/cli/src/api/rpc/types';
import { registerMachineTerminalRpcHandlers } from '../../../../apps/cli/src/api/machine/rpcHandlers.terminal';
import { createTerminalPtySessionManager } from '../../../../apps/cli/src/terminal/pty/sessions';
import type { PtyProcess } from '../../../../apps/cli/src/terminal/pty/provider';
import { createMachineRpcTerminalStreamCarrier } from '../../../../apps/ui/sources/sync/domains/terminal/stream/carrier';

const transport = vi.hoisted(() => ({ receive: undefined as undefined | ((method: string, payload: unknown) => Promise<unknown>), reads: 0 }));
// Only the network hop is replaced; the UI producer, strict daemon handler,
// session manager, byte ring and response mapping remain real.
vi.mock('../../../../apps/ui/sources/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: { method: string; payload: unknown }) => {
        if (request.method === 'daemon.terminal.stream.readBytes') transport.reads++;
        if (!transport.receive) throw new Error('Terminal transport is not attached');
        return transport.receive(request.method, request.payload);
    },
}));

afterEach(() => { transport.receive = undefined; transport.reads = 0; });

it('reads and acknowledges one terminal concurrently from two independent renderer cursors', async () => {
    const listeners = new Set<(data: Buffer | string) => void>();
    // The OS PTY is the other genuine boundary. No real shell is launched.
    const pty: PtyProcess = {
        pid: 0, write() {}, resize() {}, kill() {},
        onData: () => ({ dispose() {} }),
        onDataBytes: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
        onExit: () => ({ dispose() {} }),
    };
    const manager = createTerminalPtySessionManager({
        ptyProvider: { spawn: () => pty }, env: { SHELL: '/bin/sh' }, platform: 'linux',
        stopProcessTree: async () => {},
        config: { bufferMaxBytes: 1_000_000, bufferMaxEvents: 1000, 
            urlParseBufferLimit: 32_768, maxWriteChunkBytes: 16_384, defaultCols: 80, defaultRows: 24 },
    });
    const registered = new Map<string, RpcHandler>();
    const registration = registerMachineTerminalRpcHandlers({
        rpcHandlerManager: { registerHandler: (method, handler) => { registered.set(method, handler); } },
        deps: { serverId: 'home', resolveHostHomeServerIdentityId: async () => 'stable-home',
            env: {}, workingDirectory: process.cwd(), sessionManager: manager },
    });
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
            installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true };
    transport.receive = async (method, payload) => {
        const handler = registered.get(method);
        if (!handler) throw new Error('Terminal handler is not registered');
        return handler(payload, context);
    };
    try {
        const ensured = await transport.receive(RPC_METHODS.DAEMON_TERMINAL_ENSURE,
            { terminalKey: 'concurrent-renderers', cwd: process.cwd(), cols: 80, rows: 24 });
        if (!ensured || typeof ensured !== 'object' || !('terminalId' in ensured) || typeof ensured.terminalId !== 'string') {
            throw new Error('Terminal ensure failed');
        }
        const terminalId = ensured.terminalId;
        const viewers = ['rail', 'companion'].map(rendererId => ({ rendererId, cursor: 0,
            carrier: createMachineRpcTerminalStreamCarrier({ machineId: 'machine', serverId: 'home' }) }));
        for (const listener of listeners) listener(Buffer.alloc(8, 65));
        // Different page sizes make the second viewer resume behind the first.
        for (const maxBytes of [4, 8]) {
            await Promise.all(viewers.map(async (viewer, index) => {
                const result = await viewer.carrier.read({ terminalId, rendererId: viewer.rendererId,
                    cursor: { mode: 'byte-offset', value: viewer.cursor }, ackedByteOffset: viewer.cursor,
                    creditBytes: 8, maxBytes: index === 0 ? maxBytes : 2, surfaceEpoch: index });
                expect(result.ok).toBe(true);
                if (!result.ok) throw new Error(`Terminal read refused: ${result.code}`);
                viewer.cursor = result.nextCursor;
                await viewer.carrier.acknowledge({ terminalId, rendererId: viewer.rendererId,
                    ackedByteOffset: viewer.cursor, creditBytes: 8, surfaceEpoch: index });
            }));
        }
        expect(viewers.map(viewer => viewer.cursor)).toEqual([8, 4]);
        expect(transport.reads).toBe(4);
        // A malformed ACK remains refused by the real daemon trust boundary.
        const malformed = { terminalId, byteOffset: 0, ackedByteOffset: 1 };
        const parsed = TerminalStreamReadRequestSchema.safeParse(malformed);
        expect(parsed.success).toBe(false);
        if (!parsed.success) expect(parsed.error.issues.map(issue => issue.path)).toContainEqual(['ackedByteOffset']);
        expect(await transport.receive(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES, malformed))
            .toMatchObject({ ok: false, code: 'terminal_invalid_request' });
    } finally { registration.dispose(); manager.dispose(); }
});
