import * as React from 'react';
import { expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
const { MiddleEllipsisText } = await import('./MiddleEllipsisText');

function flatten(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

it('draws both halves of a split value in the caller\'s face, so a mono id stays mono on the web (U8 R6 L2)', async () => {
    const screen = await renderScreen(<MiddleEllipsisText testID="value" value="04996b5 vs main" style={{ fontFamily: 'TestMono', fontSize: 13 }} />);
    try {
        // The halves inherit the line's face; they never set the default face over it.
        const halves = screen.findAll(node => typeof node.type === 'string' && node.children.some(child => typeof child === 'string'));
        expect(halves.length).toBeGreaterThan(0);
        for (const half of halves) expect(flatten(half.props.style).fontFamily).toBeUndefined();
        expect(flatten(screen.findHostByTestId('value')?.props.style).fontFamily).toBe('TestMono');
    } finally { await screen.unmount(); }
}, 180_000);
