import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';

import { installSessionFileViewCommonModuleMocks } from './sessionFileViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
}));

describe('FileBinaryState (svg previews)', () => {
    it('renders an SvgXml preview for svg data uris on native', async () => {
        const { FileBinaryState } = await import('./FileScreenState');

        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
        const base64 = Buffer.from(svg, 'utf-8').toString('base64');
        const uri = `data:image/svg+xml;base64,${base64}`;

        const theme = {
            colors: {
                surface: '#000',
                surfaceHigh: '#111',
                divider: '#222',
                textSecondary: '#bbb',
            },
        } as any;

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<FileBinaryState theme={theme} filePath="icon.svg" imagePreviewUri={uri} />)).tree;

        expect(tree.findAllByType('SvgXml' as any).length).toBe(1);
    });
});
