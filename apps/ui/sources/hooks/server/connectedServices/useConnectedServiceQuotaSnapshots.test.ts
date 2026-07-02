import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as React from 'react';
import renderer, { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';

import type { ConnectedServiceQuotaSnapshotsResult } from './useConnectedServiceQuotaSnapshots';
import {
    createDeferredAccountMode,
    createDeferredPlainSnapshot,
    fetchAccountEncryptionModeSpy,
    getConnectedServiceQuotaSnapshotPlainSpy,
    getConnectedServiceQuotaSnapshotSealedSpy,
    makeQuotaSnapshot,
    resetConnectedServiceQuotaSnapshotsTestState,
    setCurrentCredentials,
    stableCredentials,
    type ProfileRef,
} from './useConnectedServiceQuotaSnapshots.testkit';

describe('useConnectedServiceQuotaSnapshots', () => {
    beforeEach(() => {
        resetConnectedServiceQuotaSnapshotsTestState();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('refetches quota snapshots when credentials change for a cached profile', async () => {
        getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'weekly' }));

        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(
            (props: ProfileRef) => useConnectedServiceQuotaSnapshots([props]),
            { initialProps: { serviceId: 'anthropic', profileId: 'work' } },
        );

        await flushHookEffects({ cycles: 5, turns: 5 });
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

        setCurrentCredentials({ ...stableCredentials, token: 't2' });
        await hook.rerender({ serviceId: 'anthropic', profileId: 'work' });
        await flushHookEffects({ cycles: 5, turns: 5 });

        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);
        expect(getConnectedServiceQuotaSnapshotPlainSpy.mock.calls[1]?.[0].token).toBe('t2');
        await hook.unmount();
    });

    it('does not expose cached quota snapshots during credential changes before reset effects run', async () => {
        getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'old-token' }));

        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const valuesDuringCredentialChange: ConnectedServiceQuotaSnapshotsResult[] = [];
        let captureCredentialChangeRender = false;

        function Harness() {
            const value = useConnectedServiceQuotaSnapshots([{ serviceId: 'anthropic', profileId: 'work' }]);
            if (captureCredentialChangeRender) {
                valuesDuringCredentialChange.push(value);
            }
            return null;
        }

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(Harness));
        });
        await flushHookEffects({ cycles: 5, turns: 5 });

        setCurrentCredentials({ ...stableCredentials, token: 't2' });
        captureCredentialChangeRender = true;
        await act(async () => {
            tree.update(React.createElement(Harness));
        });

        expect(valuesDuringCredentialChange[0]?.snapshotsByKey['anthropic/work']).toBeNull();
        expect(valuesDuringCredentialChange[0]?.loadingByKey['anthropic/work']).toBe(false);

        await act(async () => {
            tree.unmount();
        });
    });

    it('refetches and ignores stale quota results when credential material changes under the same token', async () => {
        const oldCredentialSnapshot = createDeferredPlainSnapshot();
        const newCredentialSnapshot = createDeferredPlainSnapshot();
        getConnectedServiceQuotaSnapshotPlainSpy
            .mockReturnValueOnce(oldCredentialSnapshot.promise)
            .mockReturnValueOnce(newCredentialSnapshot.promise);

        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(
            (props: ProfileRef) => useConnectedServiceQuotaSnapshots([props]),
            { initialProps: { serviceId: 'anthropic', profileId: 'work' } },
        );

        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

        const nextCredentials = {
            ...stableCredentials,
            secret: Buffer.from(new Uint8Array(32).fill(4)).toString('base64url'),
        };
        setCurrentCredentials(nextCredentials);
        await hook.rerender({ serviceId: 'anthropic', profileId: 'work' });
        await flushHookEffects({ cycles: 3, turns: 3 });

        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);
        expect(getConnectedServiceQuotaSnapshotPlainSpy.mock.calls[1]?.[0]).toEqual(nextCredentials);

        await act(async () => {
            oldCredentialSnapshot.resolve(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'old-secret' }));
        });
        await flushHookEffects({ cycles: 5, turns: 5 });
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']).toBeNull();

        await act(async () => {
            newCredentialSnapshot.resolve(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'new-secret' }));
        });
        await flushHookEffects({ cycles: 10, turns: 10 });

        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('new-secret');
        expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(false);
        await hook.unmount();
    });

    it('does not let a stale account-mode response choose the quota endpoint after credentials change', async () => {
        vi.useFakeTimers();
        const oldMode = createDeferredAccountMode();
        const newMode = createDeferredAccountMode();
        fetchAccountEncryptionModeSpy
            .mockReturnValueOnce(oldMode.promise)
            .mockReturnValueOnce(newMode.promise);
        getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(
            makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'new-account', staleAfterMs: 1 }),
        );

        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(
            (props: ProfileRef) => useConnectedServiceQuotaSnapshots([props]),
            { initialProps: { serviceId: 'anthropic', profileId: 'work' } },
        );

        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(fetchAccountEncryptionModeSpy).toHaveBeenCalledTimes(1);
        expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalled();

        setCurrentCredentials({ ...stableCredentials, token: 't2' });
        await hook.rerender({ serviceId: 'anthropic', profileId: 'work' });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(fetchAccountEncryptionModeSpy).toHaveBeenCalledTimes(2);

        await act(async () => {
            newMode.resolve({ mode: 'plain', updatedAt: 2 });
        });
        await flushHookEffects({ cycles: 5, turns: 5 });
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            oldMode.resolve({ mode: 'e2ee', updatedAt: 1 });
        });
        await flushHookEffects({ cycles: 3, turns: 5 });
        await flushHookEffects({ cycles: 1, turns: 2, advanceTimersMs: 30_001 });
        await flushHookEffects({ cycles: 5, turns: 5 });

        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);
        expect(getConnectedServiceQuotaSnapshotSealedSpy).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('does not fall back to the sealed quota endpoint after credentials change while a plaintext miss is pending', async () => {
        const oldCredentialSnapshot = createDeferredPlainSnapshot();
        getConnectedServiceQuotaSnapshotPlainSpy
            .mockReturnValueOnce(oldCredentialSnapshot.promise)
            .mockResolvedValue(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'new-account' }));

        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(
            (props: ProfileRef) => useConnectedServiceQuotaSnapshots([props]),
            { initialProps: { serviceId: 'anthropic', profileId: 'work' } },
        );

        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

        setCurrentCredentials({ ...stableCredentials, token: 't2' });
        await hook.rerender({ serviceId: 'anthropic', profileId: 'work' });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);

        await act(async () => {
            oldCredentialSnapshot.resolve(null);
        });
        await flushHookEffects({ cycles: 5, turns: 5 });

        expect(getConnectedServiceQuotaSnapshotSealedSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('new-account');
        await hook.unmount();
    });
});
