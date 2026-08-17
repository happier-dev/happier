/**
 * `CardGrid` resolves its column count from the width its own box got.
 *
 * A card grid is a settings-pane citizen: the window it sits in says nothing
 * about the room a card actually gets, and the cards are compact readouts that
 * stay legible far below the list-row floor — so the grid declares its own.
 */

import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({ windowWidth: 1600, windowDimensionReads: 0 }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => {
            shared.windowDimensionReads += 1;
            return { width: shared.windowWidth, height: 900 };
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

async function measureGrid(screen: Screen, widthPx: number): Promise<void> {
    const hosts = screen.root.findAll((node) => (
        typeof node.type === 'string' && typeof node.props.onLayout === 'function'
    ), { deep: true });
    if (hosts.length !== 1) {
        throw new Error(`expected exactly one measuring host, found ${hosts.length}`);
    }
    await act(async () => {
        (hosts[0]!.props.onLayout as (event: unknown) => void)({
            nativeEvent: { layout: { x: 0, y: 0, width: widthPx, height: 200 } },
        });
    });
}

async function renderCardGrid(columns: 1 | 2 | 3 | 4, extra: Record<string, unknown> = {}) {
    const { CardGrid, CardGridColumn } = await import('./CardGrid');
    return await renderScreen(
        <CardGrid columns={columns} {...extra}>
            <CardGridColumn><View testID="card-1" /></CardGridColumn>
            <CardGridColumn><View testID="card-2" /></CardGridColumn>
        </CardGrid>,
    );
}

function readCardIsFullWidth(screen: Screen): boolean {
    return flattenStyle(screen.findByTestId('card-1')?.parent?.props.style).width === '100%';
}

beforeEach(() => {
    shared.windowWidth = 1600;
    shared.windowDimensionReads = 0;
});

describe('CardGrid', () => {
    it('keeps a desktop settings pane at the requested column count', async () => {
        const screen = await renderCardGrid(4);

        // Four 200px cards plus three 12px gutters need 836px, which a desktop
        // settings column comfortably has.
        await measureGrid(screen, 1160);

        expect(readCardIsFullWidth(screen)).toBe(false);
    });

    it('collapses to one card per line at phone width, whatever the window says', async () => {
        shared.windowWidth = 1600;
        const screen = await renderCardGrid(4);

        // 343px of card room cannot fit two 200px cards plus the gutter.
        await measureGrid(screen, 343);

        expect(readCardIsFullWidth(screen)).toBe(true);
    });

    it('uses a card-sized floor rather than the list-row floor', async () => {
        const screen = await renderCardGrid(2);

        // 412px fits two 200px cards but not two 320px list rows.
        await measureGrid(screen, 412);

        expect(readCardIsFullWidth(screen)).toBe(false);
    });

    it('never reads the window', async () => {
        const screen = await renderCardGrid(4);
        await measureGrid(screen, 1160);

        expect(shared.windowDimensionReads).toBe(0);
    });
});
