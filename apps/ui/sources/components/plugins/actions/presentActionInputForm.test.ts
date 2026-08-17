import { afterEach, describe, expect, it, vi } from 'vitest';

import { createActionInputForm, type ActionInputForm } from './actionInputForm';
import { presentActionInputForm } from './presentActionInputForm';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('./ActionInputFormModal', () => ({
    ActionInputFormModal: () => null,
}));

function form(): ActionInputForm {
    return {
        presentation: {
            title: 'Connect socket provider',
            description: null,
            inputHints: { fields: [] },
        },
        getInput: () => ({}),
        replaceInput: () => {},
        isRetired: () => false,
        isSubmitting: () => false,
        getFields: () => [],
        subscribe: () => () => {},
        submit: async () => ({ kind: 'settled', outcome: { ok: true } }),
        cancel: vi.fn(),
        retire: vi.fn(),
    };
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

afterEach(() => {
    vi.clearAllMocks();
});

describe('generic Action input form presenter', () => {
    it('presents a plugin-only provider descriptor through its owner callback form without a UI target or caller', async () => {
        const actionForm = form();
        const { Modal } = await import('@/modal');

        presentActionInputForm({ form: actionForm });

        expect(Modal.show).toHaveBeenCalledTimes(1);
        const config = vi.mocked(Modal.show).mock.calls[0]?.[0] as unknown as Readonly<{
            props?: Readonly<{ form: ActionInputForm; onRetire?: () => void }>;
            onRequestClose?: () => void;
            onHostUnmount?: () => void;
        }>;
        expect(config.props?.form).toBe(actionForm);
        expect(config).not.toHaveProperty('callerPluginId');

        config.onRequestClose?.();
        config.onHostUnmount?.();
        config.props?.onRetire?.();

        expect(actionForm.cancel).toHaveBeenCalledTimes(1);
        expect(actionForm.retire).toHaveBeenCalledTimes(1);
    });

    it('immediately hides and clears a generic form when its Account lifetime retires', async () => {
        const account = createAccountLifetimeHarness();
        const accountRef = {
            service: { pluginId: 'com.acme.accounts', localId: 'service' },
            accountId: 'account-a',
        };
        const actionForm = createActionInputForm({
            presentation: {
                title: 'Connect account',
                description: null,
                inputHints: {
                    fields: [{
                        path: 'credentialRef',
                        title: 'Account',
                        widget: 'select',
                        options: [{ value: accountRef, label: 'Previous Account' }],
                    }],
                },
            },
            accountLifetime: account.lifetime,
            submit: async () => ({ ok: true }),
        });
        const { Modal } = await import('@/modal');

        presentActionInputForm({ form: actionForm });
        expect(actionForm.getFields()).toEqual([
            expect.objectContaining({
                options: [expect.objectContaining({ value: accountRef, label: 'Previous Account' })],
            }),
        ]);

        account.retire();

        expect(Modal.hide).toHaveBeenCalledWith('modal-id');
        expect(actionForm.getFields()).toEqual([]);
    });
});
