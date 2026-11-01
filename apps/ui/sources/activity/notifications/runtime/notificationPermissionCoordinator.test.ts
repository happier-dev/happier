import { describe, expect, it, vi } from 'vitest';
import { createNotificationPermissionCoordinator } from './notificationPermissionCoordinator';

const request = { serverId: 'server', accountId: 'account', sessionId: 'session', requestId: 'request', occurrenceId: 'occurrence', action: 'allow' as const };

describe('notification permission callback coordination', () => {
    it('joins listener/task work and excludes conflicting decisions before and after confirmation', async () => {
        const run = createNotificationPermissionCoordinator();
        let finish!: (value: unknown) => void;
        const send = vi.fn(async (issued: () => void) => {
            issued();
            return new Promise((resolve) => { finish = resolve; });
        });
        const first = run(request, send);
        expect(run(request, send)).toBe(first);
        expect(run(request, send, { allowExecution: false })).toBe(first);
        await expect(run({ ...request, action: 'deny' }, send)).resolves.toEqual({ status: 'conflict' });
        finish({ ok: true });
        await expect(first).resolves.toEqual({ status: 'confirmed' });
        expect(run(request, send)).toBe(first);
        await expect(run({ ...request, action: 'deny' }, send)).resolves.toEqual({ status: 'conflict' });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('does not let a saved observation consume a concurrent live press', async () => {
        const run = createNotificationPermissionCoordinator();
        const send = vi.fn(async (issued: () => void) => { issued(); return { ok: true }; });
        const saved = run(request, send, { allowExecution: false });
        const live = run(request, send);
        await expect(saved).resolves.toEqual({ status: 'not_sent' });
        await expect(live).resolves.toEqual({ status: 'confirmed' });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('leaves a rejected admission retryable by a fresh press', async () => {
        const run = createNotificationPermissionCoordinator();
        const send = vi.fn(async (issued: () => void) => {
            issued();
            return send.mock.calls.length === 1 ? { ok: false, errorCode: 'permission_response_failed' } : { ok: true };
        });
        await expect(run(request, send)).resolves.toEqual({ status: 'rejected' });
        await expect(run(request, send)).resolves.toEqual({ status: 'confirmed' });
    });

    it('does not let delivery history decide a later permission occurrence', async () => {
        const run = createNotificationPermissionCoordinator();
        const send = vi.fn(async (issued: () => void) => { issued(); return { ok: true }; });
        await expect(run(request, send)).resolves.toEqual({ status: 'confirmed' });
        await expect(run({ ...request, occurrenceId: 'next', action: 'deny' }, send)).resolves.toEqual({ status: 'confirmed' });
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('does not reuse another authenticated account\'s confirmation', async () => {
        const run = createNotificationPermissionCoordinator();
        let accepted = true;
        const send = vi.fn(async (issued: () => void) => { issued(); return { ok: accepted }; });
        await expect(run(request, send)).resolves.toEqual({ status: 'confirmed' });
        accepted = false;
        await expect(run({ ...request, accountId: 'another-account' }, send)).resolves.toEqual({ status: 'rejected' });
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('leaves an unknown outcome for a fresh press without automatically retrying or executing a saved response', async () => {
        const run = createNotificationPermissionCoordinator();
        const send = vi.fn<(issued: () => void) => Promise<unknown>>(async (issued) => { issued(); throw new Error('lost acknowledgement'); });
        await expect(run(request, send)).resolves.toEqual({ status: 'unconfirmed' });
        await expect(run(request, send, { allowExecution: false })).resolves.toEqual({ status: 'not_sent' });
        expect(send).toHaveBeenCalledTimes(1);
        send.mockImplementation(async (issued) => { issued(); return { ok: true }; });
        await expect(run(request, send)).resolves.toEqual({ status: 'confirmed' });
        expect(send).toHaveBeenCalledTimes(2);
    });

    it.each([false, true])('releases cancelled work and fences late issuance, issued=%s', async (wasIssued) => {
        const run = createNotificationPermissionCoordinator();
        const controller = new AbortController();
        let issueLater!: () => void;
        let finish!: (value: unknown) => void;
        const pending = run(request, (issued, signal) => {
            issueLater = issued;
            if (wasIssued) issued();
            expect(signal.aborted).toBe(false);
            return new Promise((resolve) => { finish = resolve; });
        }, { signal: controller.signal });
        controller.abort();
        await expect(pending).resolves.toEqual({ status: wasIssued ? 'unconfirmed' : 'not_sent' });
        expect(() => issueLater()).toThrow();
        finish({ ok: true });
        const send = vi.fn(async (issued: () => void) => { issued(); return { ok: true }; });
        await expect(run({ ...request, occurrenceId: 'next' }, send)).resolves.toEqual({ status: 'confirmed' });
    });

    it.each([
        [{ ok: false }, 'rejected'],
        [undefined, 'unconfirmed'],
        [{}, 'unconfirmed'],
    ])('requires an application success acknowledgement: %j', async (result, status) => {
        const run = createNotificationPermissionCoordinator();
        await expect(run(request, async (issued) => { issued(); return result; })).resolves.toEqual({ status });
    });
});
