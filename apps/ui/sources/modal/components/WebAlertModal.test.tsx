import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';
import { ModalCardFrame } from './WebAlertModal';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const baseModalSpy = vi.fn();

vi.mock('./BaseModal', () => ({
    BaseModal: (props: any) => {
        baseModalSpy(props);
        return React.createElement('BaseModal', props, props.children);
    },
}));

installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: any) => React.createElement('View', props, props.children),
            Text: (props: any) => React.createElement('Text', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
            Platform: {
                OS: 'web',
                select: (v: any) => v.web ?? v.default ?? null,
            },
        });
    },
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

function getTextContent(node: any): string {
    const child = node?.findByType?.('Text' as any);
    const value = child?.props?.children;
    return Array.isArray(value) ? value.join('') : String(value ?? '');
}

function getNodeByTestID(screen: { findByTestId: (testID: string) => any }, testID: string) {
    return screen.findByTestId(testID);
}

describe('WebAlertModal', () => {
    it('keeps alert body content intrinsically measurable inside fit-layout cards', async () => {
        const { WebAlertModal } = await import('./WebAlertModal');

        const screen = await renderScreen(<WebAlertModal
                    config={{
                        id: 'remove-relay',
                        type: 'confirm',
                        title: 'Remove Relay',
                        message: 'Remove "localhost:52753" from saved relays?',
                        cancelText: 'Cancel',
                        confirmText: 'Remove',
                    }}
                    onClose={vi.fn()}
                    onConfirm={vi.fn()}
                />);

        const body = screen.findByTestId('modal-card-body');
        if (body == null) {
            throw new Error('expected modal card body to exist');
        }
        expect(body.props.style).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    flexGrow: 1,
                    flexShrink: 1,
                    flexBasis: 'auto',
                    minHeight: 0,
                }),
            ]),
        );
    });

    it('wraps the dialog content in the shared card frame and keeps backdrop dismissal disabled', async () => {
        const { WebAlertModal } = await import('./WebAlertModal');

        baseModalSpy.mockClear();
        const onClose = vi.fn();
        const onConfirm = vi.fn();

        await renderScreen(<WebAlertModal
                    config={{
                        id: 'test-confirm',
                        type: 'confirm',
                        title: 'Push local commits',
                        message: 'Remote: origin',
                        cancelText: 'Cancel',
                        confirmText: 'Push',
                    }}
                    onClose={onClose}
                    onConfirm={onConfirm}
                />);

        const [baseModalProps] = baseModalSpy.mock.calls.at(-1)!;
        expect(baseModalProps.closeOnBackdrop).toBe(false);
        expect(baseModalProps.showBackdrop).toBe(true);

        const modalCardFrame = React.Children.toArray(baseModalProps.children).find((child: any) => child.type === ModalCardFrame);
        expect(modalCardFrame).toBeDefined();
    });

    it('renders confirm buttons as accessible Pressables on web', async () => {
        const { WebAlertModal } = await import('./WebAlertModal');

        baseModalSpy.mockClear();
        const onClose = vi.fn();
        const onConfirm = vi.fn();

        const screen = await renderScreen(<WebAlertModal
                    config={{
                        id: 'test-confirm',
                        type: 'confirm',
                        title: 'Push local commits',
                        message: 'Remote: origin',
                        cancelText: 'Cancel',
                        confirmText: 'Push',
                    }}
                    onClose={onClose}
                    onConfirm={onConfirm}
                />);

        const pressables = [
            getNodeByTestID(screen, 'web-modal-cancel'),
            getNodeByTestID(screen, 'web-modal-confirm'),
        ];

        for (const pressable of pressables) {
            const text = getTextContent(pressable);
            expect(pressable.props.accessibilityRole).toBe('button');
            expect(pressable.props.accessibilityLabel).toBe(text);
        }
    });
});
