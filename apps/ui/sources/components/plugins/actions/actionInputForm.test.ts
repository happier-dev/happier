import { describe, expect, it, vi } from 'vitest';

import { createActionInputForm } from './actionInputForm';
import { createActionExecutor, getActionSpec } from '@happier-dev/protocol/actions';
import type { ActionId } from '@happier-dev/protocol/actions';

const widgetRequiredFields = {
    'widgets.catalog.list': ['surface'], 'widgets.item.list': ['surface'],
    'widgets.item.add': ['surface', 'instance'], 'widgets.item.remove': ['ref'],
    'widgets.item.move': ['ref', 'toIndex'], 'widgets.item.rename': ['ref', 'displayName'],
    'widgets.item.size.set': ['ref', 'size'], 'widgets.item.frame.set': ['ref', 'frameStyle'],
    'widgets.item.inputs.get': ['ref'], 'widgets.item.inputs.validate': ['ref', 'bindings'],
    'widgets.item.inputs.set': ['ref', 'bindings'], 'widgets.item.inputs.reset': ['ref'],
    'widgets.item.refresh': ['ref'],
    'widgets.group.create': ['surface', 'groupId', 'instanceIds'],
    'widgets.group.add': ['surface', 'group'], 'widgets.group.ungroup': ['ref'],
    'widgets.group.set': ['ref'], 'widgets.group.inputs.set': ['ref', 'bindings'],
    'widgets.area.layout.list': ['surface'], 'widgets.area.layout.select': ['surface'],
    'widgets.area.layout.create': ['surface', 'layoutId', 'name'],
    'widgets.area.layout.rename': ['surface', 'expectedRevision', 'name'],
    'widgets.area.layout.delete': ['surface', 'expectedRevision'],
    'widgets.area.layout.reorder': ['surface', 'expectedRevision', 'position'],
    'widgets.area.layout.reset': ['surface', 'expectedRevision'], 'widgets.area.layout.undo': ['capture'],
    'widgets.definition.list': ['account'], 'widgets.definition.get': ['account', 'artifactId'],
    'widgets.definition.create': ['account', 'artifactId', 'definition'],
    'widgets.definition.update': ['account', 'artifactId', 'patch'],
    'widgets.definition.duplicate': ['account', 'artifactId', 'newArtifactId'],
    'widgets.definition.delete': ['account', 'artifactId'],
    'widgets.definition.saveFromSession': ['account', 'session', 'itemId', 'artifactId'],
    'widgets.fragment.list': ['account'], 'widgets.fragment.get': ['account', 'artifactId'],
    'widgets.fragment.create': ['account', 'artifactId', 'fragment'],
    'widgets.fragment.update': ['account', 'artifactId', 'patch'],
    'widgets.fragment.duplicate': ['account', 'artifactId', 'newArtifactId'],
    'widgets.fragment.delete': ['account', 'artifactId'],
    'widgets.snapshot.post': ['surface', 'itemId', 'title', 'preview', 'placement'],
} satisfies Partial<Record<ActionId, readonly string[]>>;

function createSpecForm(actionId: ActionId) {
    const spec = getActionSpec(actionId);
    return createActionInputForm({
        presentation: { title: spec.title, description: spec.description, inputHints: spec.inputHints! },
        submit: async candidate => ({ ok: spec.inputSchema.safeParse(candidate).success }),
    });
}

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
    it.each(Object.entries(widgetRequiredFields))('presents the required execution inputs of %s', (id, requiredPaths) => {
        const form = createSpecForm(id as keyof typeof widgetRequiredFields);
        const fields = form.getFields();
        for (const path of requiredPaths) {
            expect(fields.find(field => field.path === path), `${id}: ${path}`).toMatchObject({ required: true, visible: true });
        }
        form.retire();
    });

    it('adapts required fields to the move and group-size input arms while retaining structured values', async () => {
        const ref = { surface: { serverId: 'home', accountId: 'account', owner: { kind: 'home' } }, instanceId: 'widget' };
        const move = createSpecForm('widgets.item.move');
        move.replaceInput({ ref, to: { surface: ref.surface, index: 0 } });
        expect(move.getFields().find(field => field.path === 'toIndex')?.required).toBe(false);
        expect(move.getFields().find(field => field.path === 'to')?.required).toBe(true);
        await expect(move.submit()).resolves.toMatchObject({ outcome: { ok: true } });
        move.retire();
        const size = createSpecForm('widgets.item.size.set');
        size.replaceInput({ ref: { ...ref, instanceId: 'group' }, width: 'half' });
        expect(size.getFields().find(field => field.path === 'size')?.required).toBe(false);
        expect(size.getFields().find(field => field.path === 'width')?.required).toBe(true);
        await expect(size.submit()).resolves.toMatchObject({ outcome: { ok: true } });
        size.retire();
    });

    it('presents every required organization-move semantic anchor, including explicit nullable values', async () => {
        const form = createSpecForm('session.organization.move');
        const input = { scope: { serverId: 'home', accountId: 'account' }, sourceRowId: 'session', sourceKind: 'leaf',
            instructionKind: 'move-to-root', targetRowId: null, containerId: null, parentRowId: null, depth: null, edge: null };
        for (const path of Object.keys(input)) {
            expect(form.getFields().find(field => field.path === path), path).toMatchObject({ required: true, visible: true });
        }
        form.replaceInput(input);
        await expect(form.submit()).resolves.toMatchObject({ outcome: { ok: true } });
        form.retire();
    });

    it('discovers the same group and frame choices through Action options and the real form', async () => {
        const executor = createActionExecutor({});
        for (const [actionId, path, values] of [
            ['widgets.group.set', 'width', ['half', 'full']],
            ['widgets.group.set', 'dividers', ['hairline', 'none']],
            ['widgets.item.frame.set', 'frameStyle', ['card', 'plain', null]],
        ] as const) {
            const form = createSpecForm(actionId);
            const field = form.getFields().find(candidate => candidate.path === path);
            const discovered = await executor.execute('action.options.resolve', { actionId, fieldPath: path }, { surface: 'ui' });
            expect(discovered).toMatchObject({ ok: true, result: { options: field?.options } });
            expect(field?.options?.map(option => option.value)).toEqual(values);
            form.retire();
        }
    });

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

    it('aborts its local submission signal but preserves a known Action settlement when the presentation retires', async () => {
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
            kind: 'settled',
            outcome: { ok: true },
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
                kind: 'settled',
                outcome: { ok: true },
            });
        } finally {
            vi.useRealTimers();
        }
    });
});
