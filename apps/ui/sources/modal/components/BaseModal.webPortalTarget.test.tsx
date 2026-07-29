import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

import { installModalComponentCommonModuleMocks } from './modalComponentTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const createPortalMock = vi.hoisted(() => vi.fn((node: any) => node));

installModalComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
});

vi.mock('@/utils/web/radixCjs', () => ({
    requireRadixDismissableLayer: () => ({
        Branch: ({ children, ...rest }: any) => React.createElement('Branch', rest, children),
    }),
}));

vi.mock('@/utils/web/reactDomCjs', () => ({
    requireReactDOM: () => ({
        createPortal: createPortalMock,
    }),
}));

describe('BaseModal web portal target', () => {
    it('defaults to document.body on web when webPortalTarget is omitted', async () => {
        const { BaseModal } = await import('./BaseModal');
        const previousDocument = (globalThis as any).document;

        createPortalMock.mockReset();
        (globalThis as any).document = {
            body: { nodeType: 1, style: {} },
            addEventListener: () => {},
            removeEventListener: () => {},
            activeElement: null,
        } as any;
        const expectedPortalTarget = (globalThis as any).document.body;

        try {
            await renderScreen(
                <BaseModal visible={true}>
                    <div />
                </BaseModal>,
            );
        } finally {
            (globalThis as any).document = previousDocument;
        }

        expect(createPortalMock).toHaveBeenCalled();
        expect((createPortalMock.mock.calls as any[][])[0]?.[1]).toBe(expectedPortalTarget);
    });

    it('inherits the nearest modal portal target when the prop is omitted', async () => {
        const { BaseModal } = await import('./BaseModal');
        const { ModalPortalTargetProvider } = await import('@/modal/portal/ModalPortalTarget');
        const inheritedPortalTarget = { nodeType: 1 } as unknown as Element;
        const previousDocument = (globalThis as any).document;

        createPortalMock.mockReset();
        (globalThis as any).document = {
            body: { nodeType: 1, style: {} },
            addEventListener: () => {},
            removeEventListener: () => {},
            activeElement: null,
        } as any;

        try {
            await renderScreen(
                <ModalPortalTargetProvider target={inheritedPortalTarget}>
                    <BaseModal visible={true}>
                        <div />
                    </BaseModal>
                </ModalPortalTargetProvider>,
            );
        } finally {
            (globalThis as any).document = previousDocument;
        }

        expect(createPortalMock).toHaveBeenCalled();
        expect((createPortalMock.mock.calls as any[][])[0]?.[1]).toBe(inheritedPortalTarget);
    });

    it('renders into the provided web portal target when supplied', async () => {
        const { BaseModal } = await import('./BaseModal');
        const { ModalPortalTargetProvider } = await import('@/modal/portal/ModalPortalTarget');
        const portalTarget = { nodeType: 1 } as unknown as Element;
        const inheritedPortalTarget = { nodeType: 11 } as unknown as DocumentFragment;
        const previousDocument = (globalThis as any).document;

        createPortalMock.mockReset();
        (globalThis as any).document = {
            body: { nodeType: 1, style: {} },
            addEventListener: () => {},
            removeEventListener: () => {},
            activeElement: null,
        } as any;

        try {
            await renderScreen(
                <ModalPortalTargetProvider target={inheritedPortalTarget}>
                    <BaseModal visible={true} webPortalTarget={portalTarget}>
                        <div />
                    </BaseModal>
                </ModalPortalTargetProvider>,
            );
        } finally {
            (globalThis as any).document = previousDocument;
        }

        expect(createPortalMock).toHaveBeenCalled();
        expect((createPortalMock.mock.calls as any[][])[0]?.[1]).toBe(portalTarget);
    });
});
