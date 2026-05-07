import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#ffffff',
                surfaceHigh: '#f8f8f8',
                surfaceHighest: '#eeeeee',
                textSecondary: '#6c6c70',
                accent: {
                    blue: '#007aff',
                    green: '#34c759',
                    orange: '#ff9500',
                    yellow: '#ffcc00',
                    red: '#ff3b30',
                    indigo: '#5856d6',
                    purple: '#af52de',
                },
            },
        },
    });
});

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('LinearGradient', props, props.children),
}));

vi.mock('react-native-svg', () => ({
    SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props),
}));

vi.mock('@shopify/react-native-skia', () => {
    throw new Error('AvatarMeshGradient must not import Skia on web');
});

type SvgXmlProps = {
    xml: string;
};

const SvgXmlMock = 'SvgXml' as unknown as React.ComponentType<SvgXmlProps>;

function readBandPeakOpacities(xml: string): number[] {
    return [...xml.matchAll(/<linearGradient id="band-\d+"[\s\S]*?<\/linearGradient>/g)]
        .map((match) => Math.max(
            ...[...match[0].matchAll(/stop-opacity="([^"]+)"/g)].map((opacityMatch) => Number(opacityMatch[1])),
        ));
}

function readBandStopColorCounts(xml: string): number[] {
    return [...xml.matchAll(/<linearGradient id="band-\d+"[\s\S]*?<\/linearGradient>/g)]
        .map((match) => new Set(
            [...match[0].matchAll(/stop-color="([^"]+)"/g)].map((colorMatch) => colorMatch[1]),
        ).size);
}

function readBandRidgeSpans(xml: string): number[] {
    return [...xml.matchAll(/<linearGradient id="band-\d+"[\s\S]*?<\/linearGradient>/g)]
        .map((match) => {
            const stops = [...match[0].matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"/g)]
                .map((stopMatch) => ({
                    offset: Number(stopMatch[1]),
                    color: stopMatch[2],
                }));
            const baseColor = stops[0]?.color;
            const ridgeOffsets = stops
                .filter((stop) => stop.color !== baseColor)
                .map((stop) => stop.offset);

            if (ridgeOffsets.length < 2) return 0;
            return Math.max(...ridgeOffsets) - Math.min(...ridgeOffsets);
        });
}

function readStopColors(xml: string): string[] {
    return [...xml.matchAll(/stop-color="([^"]+)"/g)].map((match) => match[1]);
}

describe('AvatarMeshGradient', () => {
    it('renders without relying on Skia or CanvasKit', async () => {
        const { AvatarMeshGradient } = await import('./AvatarMeshGradient');

        const screen = await renderScreen(<AvatarMeshGradient id="session-1" size={48} />);

        expect(screen.findAllByTestId('avatar-generated-meshGradient').length).toBeGreaterThan(0);
    });

    it('renders generated SVG avatars so web and native share the same gradient pipeline', async () => {
        const { AvatarMeshGradient } = await import('./AvatarMeshGradient');

        const screen = await renderScreen(<AvatarMeshGradient id="session-1" size={48} />);
        const svg = screen.findAllByType(SvgXmlMock)[0];

        expect(svg.props.xml).toContain('<svg');
        expect(svg.props.xml).toContain('linearGradient');
        expect(svg.props.xml).toContain('radialGradient');
    });

    it('renders distinct generated SVG avatars for distinct session identities', async () => {
        const { AvatarMeshGradient } = await import('./AvatarMeshGradient');

        const first = await renderScreen(<AvatarMeshGradient id="session-1" size={48} />);
        const second = await renderScreen(<AvatarMeshGradient id="session-2" size={48} />);

        const firstSvg = first.findAllByType(SvgXmlMock)[0];
        const secondSvg = second.findAllByType(SvgXmlMock)[0];

        expect(firstSvg.props.xml).toBeTypeOf('string');
        expect(secondSvg.props.xml).toBeTypeOf('string');
        expect(secondSvg.props.xml).not.toBe(firstSvg.props.xml);
    });

    it('renders generated SVG avatars in neutral colors when monochrome is requested', async () => {
        const { AvatarMeshGradient } = await import('./AvatarMeshGradient');

        const screen = await renderScreen(<AvatarMeshGradient id="session-inactive" size={48} monochrome={true} styleId="meshGradientColumns" />);
        const xml = screen.findAllByType(SvgXmlMock)[0].props.xml;

        for (const color of readStopColors(xml)) {
            expect(color).toMatch(/^rgb\((\d+), \1, \1\)$/);
        }
    });

    it('lets explicit mesh style variants force rows, columns, and diagonal rendering', async () => {
        const { AvatarMeshGradient } = await import('./AvatarMeshGradient');

        const rows = await renderScreen(<AvatarMeshGradient id="session-1" size={48} styleId="meshGradientRows" />);
        const columns = await renderScreen(<AvatarMeshGradient id="session-1" size={48} styleId="meshGradientColumns" />);
        const diagonal = await renderScreen(<AvatarMeshGradient id="session-1" size={48} styleId="meshGradientDiagonal" />);
        const rowsXml = rows.findAllByType(SvgXmlMock)[0].props.xml;
        const columnsXml = columns.findAllByType(SvgXmlMock)[0].props.xml;
        const diagonalXml = diagonal.findAllByType(SvgXmlMock)[0].props.xml;

        expect(rowsXml).toContain('avatar-pattern-rows');
        expect(columnsXml).toContain('avatar-pattern-columns');
        expect(diagonalXml).toContain('avatar-pattern-diagonal');
        expect(diagonalXml).toContain('rotate(18');
        expect(rowsXml).not.toContain('avatar-pattern-waves');
        expect(columnsXml).not.toContain('avatar-pattern-waves');
        expect(diagonalXml).not.toContain('avatar-pattern-waves');
        expect(rowsXml.indexOf('id="avatar-fields"')).toBeLessThan(rowsXml.indexOf('id="avatar-pattern-rows"'));
        expect(columnsXml.indexOf('id="avatar-fields"')).toBeLessThan(columnsXml.indexOf('id="avatar-pattern-columns"'));
        expect(diagonalXml.indexOf('id="avatar-fields"')).toBeLessThan(diagonalXml.indexOf('id="avatar-pattern-diagonal"'));
    });

    it('keeps structured mesh variants readable with integrated highlight ridges', async () => {
        const { AvatarMeshGradient } = await import('./AvatarMeshGradient');
        const styleIds = ['meshGradientRows', 'meshGradientColumns', 'meshGradientDiagonal'] as const;
        const patternIds = {
            meshGradientRows: 'avatar-pattern-rows',
            meshGradientColumns: 'avatar-pattern-columns',
            meshGradientDiagonal: 'avatar-pattern-diagonal',
        } satisfies Record<(typeof styleIds)[number], string>;

        for (const styleId of styleIds) {
            const screen = await renderScreen(<AvatarMeshGradient id="session-structured-contrast" size={48} styleId={styleId} />);
            const xml = screen.findAllByType(SvgXmlMock)[0].props.xml;
            const patternId = patternIds[styleId];

            expect(Math.min(...readBandPeakOpacities(xml))).toBeGreaterThanOrEqual(0.4);
            expect(Math.max(...readBandPeakOpacities(xml))).toBeLessThanOrEqual(0.5);
            expect(Math.min(...readBandStopColorCounts(xml))).toBeGreaterThanOrEqual(4);
            expect(Math.min(...readBandRidgeSpans(xml))).toBeGreaterThanOrEqual(0.46);
            expect(xml).toContain(`<g id="${patternId}" opacity="0.92">`);
            expect(xml).not.toContain('id="band-seam"');
            expect(xml).not.toContain('id="avatar-structure-seams"');
            expect(xml.indexOf('id="avatar-fields"')).toBeLessThan(xml.indexOf(`id="${patternId}"`));
        }
    });
});
