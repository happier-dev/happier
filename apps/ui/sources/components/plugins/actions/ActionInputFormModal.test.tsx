import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

import { createActionInputForm, type ActionInputForm } from './actionInputForm';
import { ActionInputFormModal } from './ActionInputFormModal';

const routerPush = vi.hoisted(() => vi.fn());

type RoundButtonProps = React.ComponentProps<typeof import('@/components/ui/buttons/RoundButton').RoundButton>;
type ChromeWithFooter = Readonly<{
    footer: React.ReactElement<React.PropsWithChildren>;
}>;

function findSubmitButton(chrome: ChromeWithFooter): React.ReactElement<RoundButtonProps> | undefined {
    return React.Children.toArray(chrome.footer.props.children)
        .find((child): child is React.ReactElement<RoundButtonProps> => (
            React.isValidElement<RoundButtonProps>(child)
            && child.props.testID === 'plugin-contributed-action-form-submit'
        ));
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPush }),
}));

function failedForm(): ActionInputForm {
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
        submit: async () => ({ kind: 'settled', outcome: { ok: false } }),
        cancel: () => {},
        retire: () => {},
    };
}

function submittingForm(): ActionInputForm {
    return {
        ...failedForm(),
        isSubmitting: () => true,
    };
}

describe('ActionInputFormModal', () => {
    it('renders an external plugin declared default and submits an explicit switch override', async () => {
        const { createActionInputForm } = await import('./actionInputForm');
        const submit = vi.fn(async (_candidate: Readonly<Record<string, unknown>>) => ({ ok: true }));
        const form = createActionInputForm({
            presentation: {
                title: 'External plugin settings',
                description: null,
                inputHints: { fields: [{ path: 'enabled', title: 'Enabled', widget: 'boolean', defaultValue: true }] },
            },
            submit,
        });
        const setChrome = vi.fn();
        const anchor = { kind: 'rect', rect: { left: 12, top: 24, width: 100, height: 30 } } as const;
        const screen = await renderScreen(<ActionInputFormModal form={form} anchor={anchor} onClose={vi.fn()} setChrome={setChrome} />);
        expect(setChrome.mock.calls.at(-1)?.[0]).toMatchObject({ anchor, phonePresentation: 'sheet' });
        const control = () => screen.findAllByType('Pressable')
            .find((node) => (node.props.role ?? node.props.accessibilityRole) === 'switch');
        expect(control()?.props.accessibilityState?.checked).toBe(true);
        await pressTestInstanceAsync(control());
        expect(control()?.props.accessibilityState?.checked).toBe(false);
        await act(async () => { await form.submit(); });
        expect(submit.mock.calls[0]?.[0]).toEqual({ enabled: false });
    });

    it('keeps the cancellation action reachable while its canonical form owner is pending', async () => {
        const setChrome = vi.fn();
        const cancelForm = vi.fn();
        const onClose = vi.fn();
        const form = {
            ...submittingForm(),
            cancel: cancelForm,
        };
        await renderScreen(
            <ActionInputFormModal
                form={form}
                onClose={onClose}
                setChrome={setChrome}
            />,
        );

        // The shared card footer owns where Cancel sits; render it and read the buttons it actually draws.
        const chrome = setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter;
        const footer = await renderScreen(chrome.footer);
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const button = (testID: string) => footer.findAllByType(RoundButton)
            .find((node) => node.props.testID === testID);
        const cancel = button('plugin-contributed-action-form-cancel');
        const submit = button('plugin-contributed-action-form-submit');
        if (!cancel || !submit) throw new Error('expected Action form footer actions');

        expect(cancel.props.disabled).not.toBe(true);
        expect(submit.props.disabled).toBe(true);
        expect(submit.props.loading).toBe(true);

        cancel.props.onPress?.();
        expect(cancelForm).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('announces an asynchronous form submission failure through the shared semantic validation feedback', async () => {
        const setChrome = vi.fn();
        const screen = await renderScreen(
            <ActionInputFormModal
                form={failedForm()}
                onClose={vi.fn()}
                setChrome={setChrome}
            />,
        );
        const chrome = setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter;
        const submit = findSubmitButton(chrome);
        if (!submit) throw new Error('expected submit action in modal chrome');

        await act(async () => {
            submit.props.onPress?.();
            await Promise.resolve();
        });

        await vi.waitFor(() => {
            const feedback = screen.findAllByTestId('plugin-contributed-action-form-error');
            expect(feedback.some((node) => (
                node.props.accessibilityRole === 'alert'
                && node.props.accessibilityLiveRegion === 'polite'
            ))).toBe(true);
        });
    });

    it('presents the deciding source refusal from a real form submission through the shared reason presenter', async () => {
        const { createPluginAccountAvailabilityReaderStore } = await import('@/sync/domains/plugins/availability/reader');
        const { resolveReasonCopy } = await import('@/sync/domains/surfaces/copy/resolveReasonCopy');
        const scope = { serverId: 'form-home', accountId: 'form-account' };
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const reader = store.bind(scope);
        const form = createActionInputForm({ presentation: failedForm().presentation, submit: async () => {
            const result = reader.readCurrentArtifact({ pluginId: 'acme.form', contributionId: 'run', tier: 'reactNative', platform: 'web' });
            if (result.kind !== 'unavailable') throw new Error('Expected missing selected slot');
            return { ok: false, code: result.code, layer: 'artifact' as const, phase: 'admission' as const, retryable: false };
        } });
        const setChrome = vi.fn();
        const screen = await renderScreen(<ActionInputFormModal form={form} onClose={vi.fn()} setChrome={setChrome} />);
        const submit = findSubmitButton(setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter);
        if (!submit) throw new Error('Expected real form submit');
        await act(async () => { submit.props.onPress?.(); await Promise.resolve(); });
        expect(screen.getTextContent()).toContain(resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: 'artifact_not_current' }).body);
        await act(async () => { form.retire(); });
    });

    it('offers adding a Connected Account beside a Connected Account choice that already has accounts', async () => {
        const setChrome = vi.fn();
        const form = createActionInputForm({
            presentation: { title: 'Set up Discord Channels', description: null, choosesConnectedAccount: true, inputHints: { fields: [{
                path: 'credentialRef', title: 'Connected account', widget: 'select',
                options: [{ value: 'account-1', label: 'Happier QA Bot' }],
            }] } },
            submit: async () => ({ ok: true }),
        });
        try {
            const screen = await renderScreen(<ActionInputFormModal form={form} onClose={vi.fn()} setChrome={setChrome} />);
            const chrome = setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter;
            const handoff = React.Children.toArray(chrome.footer.props.children)
                .find((child): child is React.ReactElement<RoundButtonProps> => (
                    React.isValidElement<RoundButtonProps>(child)
                    && child.props.testID === 'plugin-contributed-action-form-repair-connected-accounts'
                ));
            expect(handoff).toBeDefined();
            // The choice is not empty, so nothing says it is.
            expect(screen.findAllByTestId('plugin-contributed-action-form-connected-accounts-empty')).toHaveLength(0);
        } finally { await act(async () => { form.retire(); }); }
    });

    it.each([null, { machineId: 'settings-machine', serverId: 'settings-home' }])(
        'repairs empty Connected Account options on the admitted form target %j', async pickerContext => {
            const { Modal } = await import('@/modal');
            const show = vi.spyOn(Modal, 'show').mockReturnValue('repair-connect');
            const setChrome = vi.fn();
            const onClose = vi.fn();
            routerPush.mockClear();
            const form = createActionInputForm({
                presentation: { title: 'Connect account', description: null, inputHints: { fields: [{
                    path: 'credentialRef', title: 'Connected account', widget: 'select', options: [],
                    resolvedEmptyConnectedAccountOptions: true,
                }] } },
                submit: async () => ({ ok: true }),
            });
            try {
                const screen = await renderScreen(<ActionInputFormModal form={form}
                    pickerContext={pickerContext ?? undefined} onClose={onClose} setChrome={setChrome} />);
                const chrome = setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter;
                const repair = React.Children.toArray(chrome.footer.props.children)
                    .find((child): child is React.ReactElement<RoundButtonProps> => (
                        React.isValidElement<RoundButtonProps>(child)
                        && child.props.testID === 'plugin-contributed-action-form-repair-connected-accounts'
                    ));
                expect(screen.findAllByTestId('plugin-contributed-action-form-connected-accounts-empty')).not.toHaveLength(0);
                expect(repair).toBeDefined();
                await act(async () => { repair?.props.onPress?.(); });
                expect(form.isRetired()).toBe(true);
                expect(onClose).toHaveBeenCalledOnce();
                expect(show).toHaveBeenCalledOnce();
                expect(show.mock.calls[0]![0].props?.request.initialMachineTarget).toEqual(pickerContext
                    ? { serverIdentityId: pickerContext.serverId, machineId: pickerContext.machineId } : undefined);
                expect(routerPush).not.toHaveBeenCalled();
                show.mock.calls[0]![0].onRequestClose?.();
            } finally { show.mockRestore(); }
        },
    );
});
