import { describe, expect, it, vi } from 'vitest';

import { createActionInputForm } from './actionInputForm';

function createAccountLifetimeHarness() {
    let current = true;
    const callbacks = new Set<() => void>();
    return {
        lifetime: {
            isCurrent: () => current,
            onRetire: (callback: () => void) => {
                callbacks.add(callback);
                return { dispose: () => callbacks.delete(callback) };
            },
        },
        retire() {
            current = false;
            for (const callback of [...callbacks]) callback();
        },
    };
}

describe('generic Action input form', () => {
    it('hands a normalized transient candidate to its owner callback without a plugin caller or dispatch target', async () => {
        const submit = vi.fn(async (candidate: Readonly<Record<string, unknown>>) => ({ ok: true as const }));
        const form = createActionInputForm({
            presentation: {
                title: 'Connect socket provider',
                description: 'Enter the pairing details.',
                inputHints: {
                    fields: [{
                        path: 'socketUrl',
                        title: 'Socket URL',
                        widget: 'url',
                    }, {
                        path: 'pairingCode',
                        title: 'Pairing code',
                        widget: 'secret',
                    }, {
                        path: 'topics',
                        title: 'Topics',
                        widget: 'multiselect',
                        options: [
                            { value: 'one', label: 'One' },
                            { value: 'two', label: 'Two' },
                        ],
                        maxSelections: 1,
                    }],
                },
            },
            isCurrent: () => true,
            submit,
        });

        form.replaceInput({
            socketUrl: 'wss://example.test/socket',
            pairingCode: 'never-retain-this',
            topics: ['one', 'two'],
        });

        await expect(form.submit()).resolves.toEqual({
            kind: 'settled',
            outcome: { ok: true },
        });
        expect(submit.mock.calls[0]?.[0]).toEqual({
            socketUrl: 'wss://example.test/socket',
            pairingCode: 'never-retain-this',
            topics: ['two'],
        });
        expect(form.getInput()).toEqual({});
    });

    it('submits the normalized latest multiselect value without rewriting the retained draft after failure', async () => {
        const submit = vi.fn(async () => ({ ok: false as const }));
        const form = createActionInputForm({
            presentation: {
                title: 'Connect socket provider',
                description: null,
                inputHints: {
                    fields: [{
                        path: 'topics',
                        title: 'Topics',
                        widget: 'multiselect',
                        maxSelections: 1,
                        options: [
                            { value: 'one', label: 'One' },
                            { value: 'two', label: 'Two' },
                        ],
                    }],
                },
            },
            submit,
        });

        form.replaceInput({ topics: ['one', 'two'] });

        await expect(form.submit()).resolves.toEqual({
            kind: 'settled',
            outcome: { ok: false },
        });
        expect(submit).toHaveBeenCalledWith(
            { topics: ['two'] },
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        // The dispatch candidate follows the Protocol owner, but a failed
        // submission does not silently rewrite the user's retained form
        // draft. Interactive selections already arrive in canonical order;
        // this protects a form restored or updated through another valid
        // owner from an unrequested post-failure mutation.
        expect(form.getInput()).toEqual({ topics: ['one', 'two'] });
    });

    it('retains only safe draft fields after a rejected submission while clearing nested secret presentation state', async () => {
        let form!: ReturnType<typeof createActionInputForm>;
        let inputWhileSubmitting: Readonly<Record<string, unknown>> | undefined;
        const submit = vi.fn(async () => {
            inputWhileSubmitting = form.getInput();
            return { ok: false as const };
        });
        form = createActionInputForm({
            presentation: {
                title: 'Connect socket provider',
                description: null,
                inputHints: {
                    fields: [{
                        path: 'endpoint',
                        title: 'Endpoint',
                        widget: 'url',
                    }, {
                        path: 'credentials.token',
                        title: 'Token',
                        widget: 'secret',
                    }],
                },
            },
            submit,
        });

        const safeInput = { endpoint: 'https://example.test/socket' };
        form.replaceInput({
            ...safeInput,
            credentials: { token: 'never-retain-this' },
        });

        await expect(form.submit()).resolves.toEqual({
            kind: 'settled',
            outcome: { ok: false },
        });
        expect(inputWhileSubmitting).toEqual(safeInput);
        expect(form.getInput()).toEqual(safeInput);
        expect(submit).toHaveBeenCalledWith({
            ...safeInput,
            credentials: { token: 'never-retain-this' },
        }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it('allows only one of three rapid submissions to reach its owner while dispatch is pending', async () => {
        let settleSubmission: (result: Readonly<{ ok: true }>) => void = () => {
            throw new Error('submission resolver was not initialized');
        };
        const pendingSubmission = new Promise<Readonly<{ ok: true }>>((resolve) => {
            settleSubmission = resolve;
        });
        const submit = vi.fn(async () => await pendingSubmission);
        const form = createActionInputForm({
            presentation: {
                title: 'Connect socket provider',
                description: null,
                inputHints: { fields: [] },
            },
            submit,
        });

        const first = form.submit();
        const second = form.submit();
        const third = form.submit();

        expect(submit).toHaveBeenCalledOnce();
        await expect(second).resolves.toEqual({
            kind: 'unavailable',
            reason: 'submission_in_flight',
        });
        await expect(third).resolves.toEqual({
            kind: 'unavailable',
            reason: 'submission_in_flight',
        });

        settleSubmission({ ok: true });
        await expect(first).resolves.toEqual({
            kind: 'settled',
            outcome: { ok: true },
        });
        expect(submit).toHaveBeenCalledOnce();
    });

    it('aborts its local submission signal and rejects a late settlement when the presentation retires', async () => {
        let settleSubmission: (result: Readonly<{ ok: true }>) => void = () => {
            throw new Error('submission resolver was not initialized');
        };
        const pendingSubmission = new Promise<Readonly<{ ok: true }>>((resolve) => {
            settleSubmission = resolve;
        });
        const submit = vi.fn(async (...args: unknown[]) => await pendingSubmission);
        const form = createActionInputForm({
            presentation: {
                title: 'Connect socket provider',
                description: null,
                inputHints: {
                    fields: [{ path: 'pairingCode', title: 'Pairing code', widget: 'secret' }],
                },
            },
            submit,
        });

        form.replaceInput({ pairingCode: 'clear-on-retire' });
        const submitting = form.submit();
        await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());

        const submissionContext = submit.mock.calls[0]?.[1];
        const submissionSignal = typeof submissionContext === 'object'
            && submissionContext !== null
            && 'signal' in submissionContext
            && submissionContext.signal instanceof AbortSignal
            ? submissionContext.signal
            : null;

        form.cancel();

        expect(submissionSignal?.aborted).toBe(true);
        settleSubmission({ ok: true });
        await expect(submitting).resolves.toEqual({
            kind: 'stale',
            reason: 'presentation_retired',
        });
    });

    it('discards a rejected local submission that settles after the presentation retires', async () => {
        let rejectSubmission: (error: Error) => void = () => {
            throw new Error('submission rejecter was not initialized');
        };
        const pendingSubmission = new Promise<Readonly<{ ok: true }>>((_resolve, reject) => {
            rejectSubmission = reject;
        });
        const submit = vi.fn(async () => await pendingSubmission);
        const form = createActionInputForm({
            presentation: {
                title: 'Connect socket provider',
                description: null,
                inputHints: { fields: [] },
            },
            submit,
        });

        const submitting = form.submit();
        await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
        form.retire();
        rejectSubmission(new Error('late local failure'));

        await expect(submitting).resolves.toEqual({
            kind: 'stale',
            reason: 'presentation_retired',
        });
    });

    it('clears secret input when the presentation owner retires', () => {
        const form = createActionInputForm({
            presentation: {
                title: 'Connect socket provider',
                description: null,
                inputHints: {
                    fields: [{ path: 'pairingCode', title: 'Pairing code', widget: 'secret' }],
                },
            },
            submit: async () => ({ ok: true }),
        });

        form.replaceInput({ pairingCode: 'clear-on-retire' });
        form.retire();

        expect(form.getInput()).toEqual({});
    });

    it('retires and clears input even when an explicit-cancel observer throws', () => {
        const form = createActionInputForm({
            presentation: {
                title: 'Connect socket provider',
                description: null,
                inputHints: {
                    fields: [{ path: 'pairingCode', title: 'Pairing code', widget: 'secret' }],
                },
            },
            onCancel: () => {
                throw new Error('cancel observer failed');
            },
            submit: async () => ({ ok: true }),
        });

        form.replaceInput({ pairingCode: 'clear-even-on-observer-failure' });
        expect(() => form.cancel()).toThrow('cancel observer failed');
        expect(form.getInput()).toEqual({});
    });

    it('clears secret input synchronously when the captured Account lifetime retires', () => {
        const account = createAccountLifetimeHarness();
        const form = createActionInputForm({
            presentation: {
                title: 'Connect socket provider',
                description: null,
                inputHints: {
                    fields: [{ path: 'pairingCode', title: 'Pairing code', widget: 'secret' }],
                },
            },
            accountLifetime: account.lifetime,
            submit: async () => ({ ok: true }),
        });

        form.replaceInput({ pairingCode: 'clear-on-account-retirement' });
        account.retire();

        expect(form.getInput()).toEqual({});
    });

    it('arms the owner-supplied bounded deadline only after submission begins', async () => {
        vi.useFakeTimers();
        try {
            let resolveSubmission: (value: Readonly<{ ok: true }>) => void = () => {
                throw new Error('submission resolver was not initialized');
            };
            const pendingSubmission = new Promise<Readonly<{ ok: true }>>((resolve) => {
                resolveSubmission = resolve;
            });
            let submissionSignal: AbortSignal | undefined;
            const form = createActionInputForm({
                presentation: {
                    title: 'Connect socket provider',
                    description: null,
                    inputHints: {
                        fields: [{
                            path: 'endpoint',
                            title: 'Endpoint',
                            widget: 'url',
                        }, {
                            path: 'pairingCode',
                            title: 'Pairing code',
                            widget: 'secret',
                        }],
                    },
                },
                deadlineMs: 25,
                submit: async (_candidate, context) => {
                    submissionSignal = context.signal;
                    return await pendingSubmission;
                },
            });

            form.replaceInput({
                endpoint: 'wss://example.test/socket',
                pairingCode: 'clear-on-submit',
            });
            await vi.advanceTimersByTimeAsync(25);

            expect(form.isRetired()).toBe(false);
            expect(form.getInput()).toEqual({
                endpoint: 'wss://example.test/socket',
                pairingCode: 'clear-on-submit',
            });

            const submitting = form.submit();
            expect(submissionSignal?.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(25);

            expect(submissionSignal?.aborted).toBe(true);
            expect(form.isRetired()).toBe(true);
            expect(form.getInput()).toEqual({});
            resolveSubmission({ ok: true });
            await expect(submitting).resolves.toEqual({
                kind: 'stale',
                reason: 'presentation_retired',
            });
        } finally {
            vi.useRealTimers();
        }
    });
});
