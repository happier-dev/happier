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

function getTextContent(node: any): string {
    const child = node?.findByType?.('Text' as any);
    const value = child?.props?.children;
    return Array.isArray(value) ? value.join('') : String(value ?? '');
}

function getNodeByTestID(screen: { findByTestId: (testID: string) => any }, testID: string) {
    return screen.findByTestId(testID);
}

describe('WebAlertModal', () => {
    it('uses text ink for irreversible copy and destructive choices', async () => {
        const { WebAlertModal } = await import('./WebAlertModal');
        const { lightTheme } = await import('@/theme');
        const { StyleSheet } = await import('react-native');
        const screen = await renderScreen(<WebAlertModal config={{
            id: 'contrast', type: 'confirm', title: 'Delete',
            messageParagraphs: [{ text: 'Cannot undo', irreversible: true }],
            confirmText: 'Delete', destructive: true,
        }} onClose={() => {}} />);
        const ink = (text: string) => {
            const node = screen.findAllByType('Text').find(node => node.props.children === text);
            return StyleSheet.flatten(node?.props.style)?.color;
        };
        expect(ink('Cannot undo')).toBe(lightTheme.colors.state.warning.textForeground);
        expect(ink('Delete')).toBe(lightTheme.colors.text.primary);
        const { ModalChoiceRow } = await import('./card/ModalChoiceRow');
        const row = await renderScreen(<ModalChoiceRow choices={[{ text: 'Remove', role: 'destructive', onPress: () => {} }]} />);
        const label = row.findAllByType('Text').find(node => node.props.children === 'Remove');
        expect(StyleSheet.flatten(label?.props.style)?.color).toBe(lightTheme.colors.state.danger.textForeground);
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
        expect(baseModalProps.accessibilityLabel).toBe('Push local commits');

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
            // Web renders the shared pressable's ARIA role.
            expect(pressable.props.role ?? pressable.props.accessibilityRole).toBe('button');
            expect(pressable.props.accessibilityLabel).toBe(text);
        }
    });

    it('settles an explicit confirm choice without also reporting a dismissal', async () => {
        const { WebAlertModal } = await import('./WebAlertModal');
        const onClose = vi.fn();
        const onConfirm = vi.fn();

        const screen = await renderScreen(<WebAlertModal
                    config={{
                        id: 'test-confirm',
                        type: 'confirm',
                        title: 'Review credential access',
                        cancelText: 'Cancel',
                        confirmText: 'Approve and save',
                    }}
                    onClose={onClose}
                    onConfirm={onConfirm}
                />);

        getNodeByTestID(screen, 'web-modal-confirm').props.onPress();

        expect(onConfirm).toHaveBeenCalledOnce();
        expect(onConfirm).toHaveBeenCalledWith(true);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('settles an explicit cancel choice through the confirm result', async () => {
        const { WebAlertModal } = await import('./WebAlertModal');
        const onClose = vi.fn();
        const onConfirm = vi.fn();

        const screen = await renderScreen(<WebAlertModal
                    config={{
                        id: 'test-confirm',
                        type: 'confirm',
                        title: 'Review credential access',
                    }}
                    onClose={onClose}
                    onConfirm={onConfirm}
                />);

        getNodeByTestID(screen, 'web-modal-cancel').props.onPress();

        expect(onConfirm).toHaveBeenCalledOnce();
        expect(onConfirm).toHaveBeenCalledWith(false);
        expect(onClose).not.toHaveBeenCalled();
    });
    it('settles an Escape dismissal of an alert through its cancel choice so a waiting guard is released', async () => {
        const { WebAlertModal } = await import('./WebAlertModal');

        baseModalSpy.mockClear();
        const onClose = vi.fn();
        const onDiscard = vi.fn();
        const onKeepEditing = vi.fn();

        await renderScreen(<WebAlertModal
                    config={{
                        id: 'test-alert',
                        type: 'alert',
                        title: 'Discard changes',
                        message: 'You have unsaved changes.',
                        buttons: [
                            { text: 'Discard', style: 'destructive', onPress: onDiscard },
                            { text: 'Keep editing', style: 'cancel', onPress: onKeepEditing },
                        ],
                    }}
                    onClose={onClose}
                />);

        const [baseModalProps] = baseModalSpy.mock.calls.at(-1)!;
        baseModalProps.onClose();

        expect(onKeepEditing).toHaveBeenCalledOnce();
        expect(onDiscard).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('settles an explicit alert button once, without also running the cancel choice', async () => {
        const { WebAlertModal } = await import('./WebAlertModal');
        const onClose = vi.fn();
        const onDiscard = vi.fn();
        const onKeepEditing = vi.fn();

        const screen = await renderScreen(<WebAlertModal
                    config={{
                        id: 'test-alert',
                        type: 'alert',
                        title: 'Discard changes',
                        buttons: [
                            { text: 'Discard', style: 'destructive', onPress: onDiscard },
                            { text: 'Keep editing', style: 'cancel', onPress: onKeepEditing },
                        ],
                    }}
                    onClose={onClose}
                />);

        getNodeByTestID(screen, 'web-modal-button-0').props.onPress();

        expect(onDiscard).toHaveBeenCalledOnce();
        expect(onKeepEditing).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('renders no text node inside the content view when the message is empty', async () => {
        const { WebAlertModal } = await import('./WebAlertModal');

        const screen = await renderScreen(<WebAlertModal
                    config={{
                        id: 'test-confirm',
                        type: 'confirm',
                        title: 'Delete a New Session draft',
                        message: '',
                        cancelText: 'Cancel',
                        confirmText: 'OK',
                    }}
                    onClose={vi.fn()}
                    onConfirm={vi.fn()}
                />);

        // A bare '' child of a View is an invalid text node on web.
        const bareText = screen.root.findAll((node) => {
            const children = node.props?.children;
            return children === '' || (Array.isArray(children) && children.includes(''));
        });
        expect(bareText).toHaveLength(0);
    });
});
