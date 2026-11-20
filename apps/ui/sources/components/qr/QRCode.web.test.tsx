import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import renderer, { act } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A pure SVG drawing: rendered on its own, without the app providers.
async function renderScreen(element: React.ReactElement) {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(element); });
    return { findAll: (predicate: Parameters<renderer.ReactTestInstance['findAll']>[0]) => tree.root.findAll(predicate) };
}

import { QRCode } from './QRCode.web';
import { createQRMatrix } from './qrMatrix';

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

    it('fills its whole size when its paper already provides the quiet zone (a long pairing link stays readable)', async () => {
        vi.stubGlobal('window', { devicePixelRatio: 1 });
        try {
            // A pairing-link-sized payload whose built-in four-module margin would cost a whole pixel per module.
            const data = Array.from({ length: 40 }, (_, step) => `happier:///restore?invite=${'x'.repeat(100 + step * 10)}`)
                .find((candidate) => {
                    const modulesAcross = createQRMatrix(candidate, 'medium').size;
                    return Math.floor(204 / (modulesAcross + 4)) < Math.floor(204 / modulesAcross);
                })!;
            const modulesAcross = createQRMatrix(data, 'medium').size;
            const screen = await renderScreen(<QRCode data={data} size={204} quietZone={false} />);
            const modules = screen.findAll((node) => (
                node.type === 'rect' && node.props?.fill === '#000000' && node.props?.rx === undefined
            ));
            expect(modules[0].props.width).toBe(Math.floor(204 / modulesAcross));
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('keeps the larger whole-pixel module by spilling into its paper when the code is a few pixels too wide', async () => {
        vi.stubGlobal('window', { devicePixelRatio: 1 });
        try {
            const data = Array.from({ length: 200 }, (_, step) => `happier:///restore?invite=${'x'.repeat(100 + step * 5)}`)
                .find((candidate) => {
                    const modulesAcross = createQRMatrix(candidate, 'medium').size;
                    return Math.floor(204 / modulesAcross) === 1 && Math.floor(216 / modulesAcross) === 2;
                })!;
            const screen = await renderScreen(<QRCode data={data} size={204} quietZone={false} bleed={6} />);
            const modules = screen.findAll((node) => (
                node.type === 'rect' && node.props?.fill === '#000000' && node.props?.rx === undefined
            ));
            expect(modules[0].props.width).toBe(2);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('draws every module on the device pixel grid, never spilling into its neighbours (a small code stays sharp)', async () => {
        vi.stubGlobal('window', { devicePixelRatio: 2 });
        try {
            const screen = await renderScreen(<QRCode data="https://happier.dev/appstore" size={72} />);
            const modules = screen.findAll((node) => (
                node.type === 'rect' && node.props?.fill === '#000000' && node.props?.rx === undefined
            ));
            expect(modules.length).toBeGreaterThan(0);
            const onGrid = (value: number) => Math.abs(value * 2 - Math.round(value * 2)) < 1e-6;
            const widths = new Set(modules.map((node) => node.props.width));
            // One module width, a whole number of device pixels, and every module starts on a pixel edge.
            expect(widths.size).toBe(1);
            expect(onGrid([...widths][0] as number)).toBe(true);
            expect(modules.every((node) => onGrid(node.props.x) && onGrid(node.props.y))).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
