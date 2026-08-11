import React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { QRCode } from './QRCode.web';

describe('QRCode.web', () => {
    it('keeps finder rings independent of a transparent background', async () => {
        const screen = await renderScreen(
            <QRCode
                data="happier:///account/connect?publicKey=test"
                size={260}
                foregroundColor="#FFFFFF"
                backgroundColor="transparent"
            />,
        );

        const backgroundFills = screen.findAll((node) => (
            typeof node.type === 'string' && node.props?.fill === 'transparent'
        ));
        expect(backgroundFills).toHaveLength(1);
        expect(backgroundFills[0].type).toBe('rect');
        expect(backgroundFills[0].props.width).toBe(260);
        expect(backgroundFills[0].props.height).toBe(260);

        const ringPaths = screen.findAll((node) => (
            node.type === 'path'
            && node.props?.fillRule === 'evenodd'
            && node.props?.fill === '#FFFFFF'
            && (String(node.props?.d).match(/M /g) ?? []).length === 2
        ));
        expect(ringPaths).toHaveLength(3);
    });
});
