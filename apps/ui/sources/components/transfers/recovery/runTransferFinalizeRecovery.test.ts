import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { AccountSettingsV2GetResponseSchema, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { IModal } from '@/modal';
import type { TransferFinalizeRecoveryAction } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';
import { createDirectTransferFinalizeRecovery } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit';
import { installTransferProjection, transferFeatures, transferMachine } from '@/components/sessions/files/sessionFileTransferTestkit';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { runTransferFinalizeRecovery } from './runTransferFinalizeRecovery';
import type { TransferFinalizeRecoveryModal } from './TransferFinalizeRecoveryModal';

const modalShowMock = vi.hoisted(() => vi.fn<IModal['show']>());
const finalizeHttp = vi.hoisted(() => vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>());
const abortRpc = vi.hoisted(() => vi.fn<(request: { method: string; payload: unknown }) => Promise<unknown>>());

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit')).createModalModuleMock({ spies: { show: modalShowMock } }).module);

// Real Socket, encryption, routing and Account owners remain above the wire boundary.
installDisconnectedServerSocketBoundary(socket => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'emit').mockReturnValue(socket);
    vi.spyOn(socket, 'disconnect').mockImplementation(() => {
        socket.connected = false;
        for (const listener of socket.listeners('disconnect')) listener('io client disconnect');
        return socket;
    });
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
        if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
        // Socket's untyped wire payload is narrowed at this genuine transport boundary.
        const request = payload as { method: string; params: unknown };
        expect(request.method).toBe(`machine-1:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT}`);
        return { ok: true, result: await abortRpc({ method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT, payload: request.params }) };
    });
});

const machineOrigin = 'https://machine.example.test';
const finalizedBody = { success: true, finalized: { success: true, path: '/repo/file.txt', sizeBytes: 4 }, sha256: 'a'.repeat(64) };

function choose(config: Parameters<IModal['show']>[0], action: TransferFinalizeRecoveryAction) {
    // The modal SDK carries generic props; this invocation mounts the known recovery modal.
    const props = config.props as ComponentProps<typeof TransferFinalizeRecoveryModal>;
    props.onResolve(action);
}

describe('runTransferFinalizeRecovery', () => {
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    beforeAll(loadSyncSingletonForTests);
    beforeEach(async () => {
        modalShowMock.mockReset();
        finalizeHttp.mockReset().mockImplementation(async () => Response.json(finalizedBody));
        abortRpc.mockReset().mockResolvedValue({ success: true, aborted: true });
        const features = createRootLayoutFeaturesResponse({ features: { machines: transferFeatures().features.machines } });
        const homeRequest = async (url: RequestInfo | URL) => {
            const path = new URL(String(url)).pathname;
            if (path === '/health') return Response.json({ status: 'ok' });
            if (path === '/v1/features') return Response.json(features);
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
            if (path === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({
                content: { t: 'plain', v: {} }, version: 0,
            }));
            if (path === '/v1/machines/machine-1') return Response.json({ machine: {
                id: 'machine-1', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            } });
            if (path.includes('/machines')) return Response.json({ machines: [] });
            return Response.json({}, { status: 404 });
        };
        connection = await restoreServerAccountForTest({ serverUrl: 'https://finalize-recovery.test', accountId: 'alice', request: homeRequest });
        installTransferProjection({ serverId: connection.home.id, session: null,
            machine: transferMachine({ id: 'machine-1', storageMode: 'plain', activeAt: Date.now() }), features });
        setRuntimeFetch(async (url, init) => {
            const request = new URL(String(url));
            if (request.origin === machineOrigin) {
                expect(request.pathname).toBe('/direct/imports/upload-1/finalize');
                expect(init?.method).toBe('POST');
                return finalizeHttp(url, init);
            }
            expect(request.origin).toBe(connection.home.serverUrl);
            if (request.pathname === '/v1/auth/ping') return Response.json({});
            return homeRequest(url);
        });
    });
    afterEach(async () => {
        await connection?.dispose();
        resetRuntimeFetch();
    });

    function createRecovery() {
        return createDirectTransferFinalizeRecovery({
            machineId: 'machine-1', serverId: connection.home.id, uploadId: 'upload-1',
            baseUrl: `${machineOrigin}/direct/imports/upload-1`, expiresAt: Date.now() + 60_000,
            parseFinalizeResponse: response => response.finalized.path,
        });
    }

    function run(recovery = createRecovery()) {
        return runTransferFinalizeRecovery({ recovery, title: 'Upload needs attention', message: 'The upload is staged.' });
    }

    it('invokes only the explicitly selected finalize retry action', async () => {
        modalShowMock.mockImplementationOnce(config => { choose(config, 'retry_finalize'); return 'recovery-modal'; });
        await expect(run()).resolves.toEqual({ status: 'finalized', response: '/repo/file.txt' });
        expect(finalizeHttp).toHaveBeenCalledTimes(1);
        expect(abortRpc).not.toHaveBeenCalled();
    });

    it('retains invocation-local custody by disabling shared modal dismissal', async () => {
        modalShowMock.mockImplementationOnce(config => {
            expect(config.closeOnBackdrop).toBe(false);
            expect(config.dismissible).toBe(false);
            expect(config.onRequestClose).toBeUndefined();
            choose(config, 'discard_staged');
            return 'recovery-modal';
        });
        await expect(run()).resolves.toEqual({ status: 'discarded' });
        expect(abortRpc).toHaveBeenCalledWith({ method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT, payload: { uploadId: 'upload-1' } });
        expect(abortRpc).toHaveBeenCalledTimes(1);
        expect(finalizeHttp).not.toHaveBeenCalled();
    });

    it('keeps the same continuation actionable after another recovery-required result', async () => {
        finalizeHttp.mockResolvedValueOnce(Response.json({ success: false, error: 'Still staged', errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED', keepSession: true }, { status: 500 }));
        modalShowMock
            .mockImplementationOnce(config => { choose(config, 'retry_finalize'); return 'first-modal'; })
            .mockImplementationOnce(config => { choose(config, 'discard_staged'); return 'second-modal'; });
        const recovery = createRecovery();
        await expect(run(recovery)).resolves.toEqual({ status: 'discarded' });
        expect(finalizeHttp).toHaveBeenCalledTimes(1);
        expect(abortRpc).toHaveBeenCalledTimes(1);
        expect(recovery.isActionable()).toBe(false);
    });

    it('re-presents an indeterminate finalize outcome and waits for another explicit Retry before finalizing', async () => {
        finalizeHttp.mockRejectedValueOnce(new Error('Acknowledgement lost after issuance'));
        let chooseSecondAction!: (action: TransferFinalizeRecoveryAction) => void;
        modalShowMock
            .mockImplementationOnce(config => { choose(config, 'retry_finalize'); return 'first-modal'; })
            .mockImplementationOnce(config => { chooseSecondAction = action => choose(config, action); return 'second-modal'; });
        const recovery = createRecovery();
        const result = run(recovery);
        await vi.waitFor(() => expect(modalShowMock).toHaveBeenCalledTimes(2));
        expect(finalizeHttp).toHaveBeenCalledTimes(1);
        expect(abortRpc).not.toHaveBeenCalled();
        expect(recovery.isActionable()).toBe(true);
        chooseSecondAction('retry_finalize');
        await expect(result).resolves.toEqual({ status: 'finalized', response: '/repo/file.txt' });
        expect(finalizeHttp).toHaveBeenCalledTimes(2);
        expect(abortRpc).not.toHaveBeenCalled();
    });

    it('re-presents a transient discard rejection and waits for another explicit Discard before settling', async () => {
        abortRpc.mockRejectedValueOnce(new Error('transport unavailable'));
        let chooseSecondAction!: (action: TransferFinalizeRecoveryAction) => void;
        modalShowMock
            .mockImplementationOnce(config => { choose(config, 'discard_staged'); return 'first-modal'; })
            .mockImplementationOnce(config => { chooseSecondAction = action => choose(config, action); return 'second-modal'; });
        const recovery = createRecovery();
        const result = run(recovery);
        await vi.waitFor(() => expect(modalShowMock).toHaveBeenCalledTimes(2));
        expect(abortRpc).toHaveBeenCalledTimes(1);
        expect(finalizeHttp).not.toHaveBeenCalled();
        chooseSecondAction('discard_staged');
        await expect(result).resolves.toEqual({ status: 'discarded' });
        expect(abortRpc).toHaveBeenCalledTimes(2);
        expect(finalizeHttp).not.toHaveBeenCalled();
    });

    it('does not re-present after the daemon authoritatively reports the staged session unavailable', async () => {
        abortRpc.mockResolvedValueOnce({ success: true, aborted: false });
        modalShowMock.mockImplementationOnce(config => { choose(config, 'discard_staged'); return 'only-modal'; });
        await expect(run()).resolves.toEqual({ status: 'unavailable', reason: 'session_unavailable',
            error: 'The staged upload could not be discarded because its session is unavailable' });
        expect(modalShowMock).toHaveBeenCalledTimes(1);
        expect(abortRpc).toHaveBeenCalledTimes(1);
        expect(finalizeHttp).not.toHaveBeenCalled();
    });

    it('does not re-present after retry discovers that the staged session is missing or expired', async () => {
        finalizeHttp.mockResolvedValueOnce(Response.json({}, { status: 404 }));
        modalShowMock.mockImplementationOnce(config => { choose(config, 'retry_finalize'); return 'only-modal'; });
        await expect(run()).resolves.toEqual({ status: 'unavailable', reason: 'session_unavailable',
            error: 'The staged upload is no longer available' });
        expect(modalShowMock).toHaveBeenCalledTimes(1);
        expect(finalizeHttp).toHaveBeenCalledTimes(1);
        expect(abortRpc).not.toHaveBeenCalled();
    });

    it('re-presents through restored modal hosts after repeated provider churn and invokes only the eventual explicit action', async () => {
        modalShowMock
            .mockImplementationOnce(config => { config.onHostUnmount?.(); return 'route-modal'; })
            .mockImplementationOnce(config => { config.onHostUnmount?.(); return 'nested-modal'; })
            .mockImplementationOnce(config => { choose(config, 'discard_staged'); return 'outer-modal'; });
        await expect(run()).resolves.toEqual({ status: 'discarded' });
        expect(modalShowMock).toHaveBeenCalledTimes(3);
        expect(abortRpc).toHaveBeenCalledTimes(1);
        expect(finalizeHttp).not.toHaveBeenCalled();
    });

    it('settles without a transfer action when no modal host remains after provider unmount', async () => {
        modalShowMock.mockImplementationOnce(config => { config.onHostUnmount?.(); return 'route-modal'; }).mockReturnValueOnce('');
        await expect(run()).resolves.toBeNull();
        expect(modalShowMock).toHaveBeenCalledTimes(2);
        expect(abortRpc).not.toHaveBeenCalled();
        expect(finalizeHttp).not.toHaveBeenCalled();
    });
});
