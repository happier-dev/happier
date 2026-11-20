import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { PairingLinkEntryForm } from './PairingLinkEntryForm';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const inputFocusSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        // The form returns focus to the field through a React Native ref after a
        // rejected draft; a host string cannot report that, so expose the imperative
        // handle the real TextInput provides.
        TextInput: ReactModule.forwardRef<{ focus: () => void }, Record<string, unknown>>(
            function TestTextInput(props, ref) {
                ReactModule.useImperativeHandle(ref, () => ({ focus: inputFocusSpy }), []);
                return ReactModule.createElement('TextInput', props);
            },
        ),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('PairingLinkEntryForm', () => {
    it('admits only one pairing attempt across Enter and the submit button while the owner is pending', async () => {
        const result = createDeferred<boolean>();
        const submit = vi.fn(() => result.promise);
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<PairingLinkEntryForm onBack={vi.fn()} onSubmit={submit} />);
        });

        const input = tree.root.findByProps({ testID: 'restore-pairing-link-input' });
        await act(async () => {
            input.props.onChangeText('happier:///pair?v=2&payload=opaque');
        });

        act(() => {
            input.props.onSubmitEditing();
        });
        await tree.root.findByProps({ testID: 'restore-pairing-link-submit' }).props.action();

        expect(submit).toHaveBeenCalledTimes(1);
        expect(tree.root.findByProps({ testID: 'restore-pairing-link-submit' }).props.loading).toBe(true);

        result.resolve(true);
        await act(async () => {
            await result.promise;
            await Promise.resolve();
        });
    });

    it('retains a rejected draft, refocuses the field, and submits the trimmed link through the supplied owner', async () => {
        inputFocusSpy.mockClear();
        const submit = vi.fn(async () => false);
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<PairingLinkEntryForm onBack={vi.fn()} onSubmit={submit} />);
        });

        const input = tree.root.findByProps({ testID: 'restore-pairing-link-input' });
        await act(async () => {
            input.props.onChangeText('  happier:///pair?v=2&payload=opaque  ');
        });
        await act(async () => {
            await tree.root.findByProps({ testID: 'restore-pairing-link-submit' }).props.action();
        });

        expect(submit).toHaveBeenCalledWith('happier:///pair?v=2&payload=opaque');
        expect(tree.root.findByProps({ testID: 'restore-pairing-link-input' }).props.value)
            .toBe('  happier:///pair?v=2&payload=opaque  ');
        expect(inputFocusSpy).toHaveBeenCalled();
        expect(tree.root.findAllByProps({ testID: 'restore-pairing-link-error' }).some(
            (node) => node.props.accessibilityRole === 'alert',
        )).toBe(true);
    });

    it('uses the supplied surface copy while keeping the restore defaults', async () => {
        let defaults!: renderer.ReactTestRenderer;
        await act(async () => {
            defaults = renderer.create(<PairingLinkEntryForm onBack={vi.fn()} onSubmit={vi.fn(async () => true)} />);
        });
        const defaultField = defaults.root.findByProps({ testID: 'restore-pairing-link-input' });
        expect(defaultField.props.placeholder).toBe('connect.pairingLinkPlaceholder');
        // The field is focused on entry and named by its own label for assistive tech.
        expect(defaultField.props.autoFocus).toBe(true);
        expect(defaultField.props.accessibilityLabel).toBe('connect.pairingLinkFieldLabel');
        expect(defaults.root.findByProps({ testID: 'restore-pairing-link-submit' }).props.title)
            .toBe('common.continue');
        expect(defaults.root.findByProps({ testID: 'restore-pairing-link-back' }).props.title)
            .toBe('common.back');

        let customized!: renderer.ReactTestRenderer;
        await act(async () => {
            customized = renderer.create(
                <PairingLinkEntryForm
                    onBack={vi.fn()}
                    onSubmit={vi.fn(async () => true)}
                    title="__title__"
                    description="__description__"
                    placeholder="__placeholder__"
                    submitLabel="__submit__"
                    backLabel="__back__"
                />,
            );
        });
        const input = customized.root.findByProps({ testID: 'restore-pairing-link-input' });
        expect(input.props.placeholder).toBe('__placeholder__');
        expect(input.props.accessibilityHint).toBe('__description__');
        expect(customized.root.findByProps({ testID: 'restore-pairing-link-submit' }).props.title)
            .toBe('__submit__');
        expect(customized.root.findByProps({ testID: 'restore-pairing-link-back' }).props.title)
            .toBe('__back__');
    });

    it('shows inline validation without invoking the submit owner for an empty link', async () => {
        const submit = vi.fn(async () => true);
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<PairingLinkEntryForm onBack={vi.fn()} onSubmit={submit} />);
        });
        await act(async () => {
            await tree.root.findByProps({ testID: 'restore-pairing-link-submit' }).props.action();
        });

        expect(submit).not.toHaveBeenCalled();
        expect(tree.root.findByProps({ testID: 'restore-pairing-link-error' })).toBeTruthy();
    });

    it('on a step, lets a pasted link proceed on its own while a typed one waits for the primary', async () => {
        const submit = vi.fn(async () => true);
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<PairingLinkEntryForm embedded onSubmit={submit} />);
        });
        const input = () => tree.root.findByProps({ testID: 'restore-pairing-link-input' });

        // Typing a link a character at a time waits for the person.
        await act(async () => {
            input().props.onChangeText('h');
        });
        expect(submit).not.toHaveBeenCalled();
        expect(tree.root.findAllByProps({ testID: 'restore-pairing-link-submit' }).length).toBeGreaterThan(0);
        await act(async () => {
            input().props.onChangeText('');
        });

        // A whole link arriving at once (a paste) goes to the owner without another press.
        await act(async () => {
            input().props.onChangeText(' happier:///pair?v=2&payload=opaque ');
        });
        expect(submit).toHaveBeenCalledTimes(1);
        expect(submit).toHaveBeenCalledWith('happier:///pair?v=2&payload=opaque');
    });
});
