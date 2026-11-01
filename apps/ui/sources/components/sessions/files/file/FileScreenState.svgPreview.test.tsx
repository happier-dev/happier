import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { AttachmentImagePreviewModal } from '@/components/sessions/attachments/preview/AttachmentImagePreviewModal';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';

import { installSessionFileViewCommonModuleMocks } from './sessionFileViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('expo-image', () => ({ Image: 'ExpoImage' }));

installSessionFileViewCommonModuleMocks({
    reactNative: installReactNativeWebMock({
        Platform: {
            OS: 'ios',
        },
    }),
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('react-native-svg', () => ({
    SvgXml: (props: any) => React.createElement('SvgXml', props),
    SvgAst: (props: any) => React.createElement('SvgAst', props),
    parse: (_xml: string, middleware?: (root: {
        tag: string;
        props: Record<string, unknown>;
        children: [];
        parent: null;
        Tag: () => null;
    }) => unknown) => {
        const root = { tag: 'svg', props: {}, children: [] as [], parent: null, Tag: () => null };
        middleware?.(root);
        return root;
    },
}));

describe('FileBinaryState (svg previews)', () => {
    it('renders a validated SvgAst preview for svg data uris on native', async () => {
        const { FileBinaryState } = await import('./FileScreenState');

        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
        const base64 = Buffer.from(svg, 'utf-8').toString('base64');
        const uri = `data:image/svg+xml;base64,${base64}`;

        const theme = {
            colors: {
                surface: {
                    base: '#000',
                    inset: '#111',
                },
                border: {
                    default: '#222',
                },
                text: {
                    secondary: '#bbb',
                },
            },
        } as any;

        let tree!: renderer.ReactTestRenderer;
        const screen = await renderScreen(<FileBinaryState theme={theme} sessionId="s1" filePath="icon.svg" imagePreviewUri={uri} />);
        tree = screen.tree;

        expect(tree.findAllByType('SvgAst' as any).length).toBe(1);
        expect(tree.findAllByType('SvgXml' as any).length).toBe(0);

        await screen.pressByTestIdAsync('file-image-preview');
        const { Modal } = await import('@/modal');
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
            component: AttachmentImagePreviewModal,
            props: {
                images: [{ kind: 'session-image', sessionId: 's1', filePath: 'icon.svg', title: 'icon.svg' }],
            },
        }));
    });
});
