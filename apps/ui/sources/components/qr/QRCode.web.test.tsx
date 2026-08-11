import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { QRCode } from './QRCode.web';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

describe('QRCode.web', () => {
    it('keeps finder rings scannable when backgroundColor is transparent', async () => {
        const screen = await renderScreen(
            <QRCode
                data="happier:///account/connect?publicKey=test"
                size={260}
                foregroundColor="#FFFFFF"
                backgroundColor="transparent"
            />,
        );

        // The quiet-zone background rect is the only shape allowed to use the
        // background color. Finder rings painted with the background color
        // disappear on transparent and leave solid 7x7 squares.
        const backgroundFills = screen.findAll((node) => (
            typeof node.type === 'string' && node.props?.fill === 'transparent'
        ));
        expect(backgroundFills).toHaveLength(1);
        expect(backgroundFills[0].type).toBe('rect');
        expect(backgroundFills[0].props.width).toBe(260);
        expect(backgroundFills[0].props.height).toBe(260);

        // Each of the three finder patterns keeps its ring as a foreground
        // shape with a punched-out hole (outer + inner subpath, even-odd),
        // independent of the background color.
        const ringPaths = screen.findAll((node) => (
            node.type === 'path'
            && node.props?.fillRule === 'evenodd'
            && node.props?.fill === '#FFFFFF'
            && (String(node.props?.d).match(/M /g) ?? []).length === 2
        ));
        expect(ringPaths).toHaveLength(3);
    });
});
