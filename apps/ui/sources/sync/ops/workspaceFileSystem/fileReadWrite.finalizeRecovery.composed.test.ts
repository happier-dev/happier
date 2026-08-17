import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { IModal } from '@/modal';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

type ModalShowInput = Parameters<IModal['show']>[0];
type GuardedMachineRpcInput = Readonly<{ method: string }>;

const modalShowBoundary = vi.hoisted(() => vi.fn<(input: ModalShowInput) => string>());
const guardedMachineRpcBoundary = vi.hoisted(() => vi.fn<(input: GuardedMachineRpcInput) => Promise<unknown>>());

function requireModalProps(input: ModalShowInput | undefined): NonNullable<ModalShowInput['props']> {
    if (!input?.props) {
        throw new Error('Expected workspace finalize recovery modal props');
    }
    return input.props;
}

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { show: modalShowBoundary },
    }).module;
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (input: GuardedMachineRpcInput) => guardedMachineRpcBoundary(input),
}));

afterEach(() => {
    delete process.env.EXPO_PUBLIC_HAPPIER_SESSION_FILE_INLINE_MAX_BYTES;
    modalShowBoundary.mockReset();
    guardedMachineRpcBoundary.mockReset();
    resetRuntimeFetch();
});

describe('workspaceWriteFile finalize recovery composition', () => {
    it('waits for explicit same-session retries and re-presents an indeterminate finalize until terminal success', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_SESSION_FILE_INLINE_MAX_BYTES = '4';
        modalShowBoundary.mockReturnValue('recovery-modal');
        const expiresAt = Date.now() + 60_000;
        guardedMachineRpcBoundary.mockImplementation(async (input) => {
            if (input.method !== RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE) {
                throw new Error(`unexpected machine RPC: ${input.method}`);
            }
            return {
                success: true,
                uploadId: 'upload-composed-recovery',
                destDisplayPath: '/repo/large.txt',
                expectedSizeBytes: 5,
                chunkSizeBytes: 5,
                recipientPublicKeyBase64: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
                expiresAt,
                endpointCandidates: [{
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-composed-recovery',
                    expiresAt,
                }],
            };
        });

        const requests: Array<Readonly<{ method: string; url: string }>> = [];
        let finalizeRequestCount = 0;
        setRuntimeFetch(async (input, init) => {
            const url = input instanceof URL ? input.toString() : String(input);
            const method = String(init?.method ?? 'GET');
            requests.push({ method, url });

            if (method === 'PUT' && url.endsWith('/chunks/0')) {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (method !== 'POST' || !url.endsWith('/finalize')) {
                throw new Error(`unexpected HTTP request: ${method} ${url}`);
            }

            finalizeRequestCount += 1;
            if (finalizeRequestCount === 1) {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Destination rollback is still incomplete',
                    errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
                    keepSession: true,
                }), {
                    status: 500,
                    headers: {
                        'content-type': 'application/json',
                        'x-happier-transfer-session-expires-at': String(expiresAt),
                    },
                });
            }
            if (finalizeRequestCount === 2) {
                return new Response(null, { status: 502 });
            }
            if (finalizeRequestCount === 3) {
                return new Response(JSON.stringify({
                    success: true,
                    finalized: {
                        success: true,
                        path: '/repo/large.txt',
                        sizeBytes: 5,
                    },
                    sha256: 'sha256:recovered',
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            throw new Error('unexpected automatic finalize retry');
        });

        const { workspaceWriteFile } = await import('./fileReadWrite');
        const result = workspaceWriteFile(
            { machineId: 'machine-1', rootPath: '/repo', serverId: 'server-1' },
            'large.txt',
            'hello',
        );

        await vi.waitFor(() => expect(modalShowBoundary).toHaveBeenCalledTimes(1));
        expect(finalizeRequestCount).toBe(1);
        expect(guardedMachineRpcBoundary).toHaveBeenCalledTimes(1);
        expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(1);

        const firstModal = modalShowBoundary.mock.calls[0]?.[0];
        requireModalProps(firstModal).onResolve('retry_finalize');
        await vi.waitFor(() => expect(modalShowBoundary).toHaveBeenCalledTimes(2));

        expect(finalizeRequestCount).toBe(2);
        expect(guardedMachineRpcBoundary).toHaveBeenCalledTimes(1);
        expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(1);

        await Promise.resolve();
        expect(finalizeRequestCount).toBe(2);

        const secondModal = modalShowBoundary.mock.calls[1]?.[0];
        requireModalProps(secondModal).onResolve('retry_finalize');

        await expect(result).resolves.toEqual({ success: true, hash: 'sha256:recovered' });
        expect(finalizeRequestCount).toBe(3);
        expect(modalShowBoundary).toHaveBeenCalledTimes(2);
        expect(guardedMachineRpcBoundary).toHaveBeenCalledTimes(1);
        expect(guardedMachineRpcBoundary).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
        }));
        expect(requests).toEqual([
            {
                method: 'PUT',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-composed-recovery/chunks/0',
            },
            {
                method: 'POST',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-composed-recovery/finalize',
            },
            {
                method: 'POST',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-composed-recovery/finalize',
            },
            {
                method: 'POST',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-composed-recovery/finalize',
            },
        ]);

        requireModalProps(secondModal).onResolve('retry_finalize');
        await Promise.resolve();
        expect(finalizeRequestCount).toBe(3);
        expect(modalShowBoundary).toHaveBeenCalledTimes(2);
    });
});
