import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

import type { ActionInputForm } from './actionInputForm';

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

function findCancelButton(chrome: ChromeWithFooter): React.ReactElement<RoundButtonProps> | undefined {
    return React.Children.toArray(chrome.footer.props.children)
        .find((child): child is React.ReactElement<RoundButtonProps> => (
            React.isValidElement<RoundButtonProps>(child)
            && child.props.testID === 'plugin-contributed-action-form-cancel'
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

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPush }),
}));

vi.mock('@/components/sessions/actions/ActionInputFields', () => ({
    ActionInputFields: () => null,
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: RoundButtonProps) => React.createElement('RoundButton', props),
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
    it('keeps the cancellation action reachable while its canonical form owner is pending', async () => {
        const { ActionInputFormModal } = await import('./ActionInputFormModal');
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

        const chrome = setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter;
        const cancel = findCancelButton(chrome);
        const submit = findSubmitButton(chrome);
        if (!cancel || !submit) throw new Error('expected Action form footer actions');

        expect(cancel.props.disabled).not.toBe(true);
        expect(submit.props.disabled).toBe(true);
        expect(submit.props.loading).toBe(true);

        cancel.props.onPress?.();
        expect(cancelForm).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('announces an asynchronous form submission failure through the shared semantic validation feedback', async () => {
        const { ActionInputFormModal } = await import('./ActionInputFormModal');
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

    it('keeps a successfully empty Connected Account form open with a repair route to its incumbent owner', async () => {
        const { ActionInputFormModal } = await import('./ActionInputFormModal');
        const setChrome = vi.fn();
        const cancel = vi.fn();
        const onClose = vi.fn();
        routerPush.mockClear();
        const form = {
            ...failedForm(),
            presentation: {
                title: 'Connect account',
                description: null,
                inputHints: {
                    fields: [{
                        path: 'credentialRef',
                        title: 'Connected account',
                        widget: 'select' as const,
                        options: [],
                        resolvedEmptyConnectedAccountOptions: true as const,
                    }],
                },
            },
            getFields: () => [{
                path: 'credentialRef',
                title: 'Connected account',
                widget: 'select' as const,
                options: [],
                resolvedEmptyConnectedAccountOptions: true as const,
                visible: true,
                required: false,
                disabled: false,
            }],
            cancel,
        };

        const screen = await renderScreen(
            <ActionInputFormModal
                form={form}
                onClose={onClose}
                setChrome={setChrome}
            />,
        );
        const chrome = setChrome.mock.calls.at(-1)?.[0] as ChromeWithFooter;
        const repair = React.Children.toArray(chrome.footer.props.children)
            .find((child): child is React.ReactElement<RoundButtonProps> => (
                React.isValidElement<RoundButtonProps>(child)
                && child.props.testID === 'plugin-contributed-action-form-repair-connected-accounts'
            ));

        expect(screen.findAllByTestId('plugin-contributed-action-form-connected-accounts-empty')).not.toHaveLength(0);
        expect(repair).toBeDefined();
        repair?.props.onPress?.();

        expect(cancel).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledOnce();
        expect(routerPush).toHaveBeenCalledWith('/(app)/settings/connected-services');
    });
});
