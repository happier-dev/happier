import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./BaseModal', () => ({
    BaseModal: ({ children }: any) => React.createElement('BaseModal', null, children),
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
    it('renders confirm buttons as accessible Pressables on web', async () => {
        const { WebAlertModal } = await import('./WebAlertModal');

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
