import * as React from 'react';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// The portal is a platform boundary; the slot, its open/close owner and the request scope remain real.
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal,
        { maxHeight: 600, maxWidth: 400, placement: 'bottom' }));

const { CollectionRequestPeek } = await import('./CollectionRequestPeek');

afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); });

const request = { kind: 'permission', serverId: 'home-unknown', sessionId: 'session-a', requestId: 'request-a', turnId: 'turn-a' } as const;

describe('CollectionRequestPeek', () => {
    it('keeps a phone request slot at the glyph and reaches the touch target with the shared hit frame', async () => {
        vi.stubGlobal('navigator', { maxTouchPoints: 1 });
        const screen = await renderScreen(<CollectionRequestPeek request={request} testID="touch-slot"><View /></CollectionRequestPeek>);
        const button = screen.findHostByTestId('touch-slot')!;
        const raw = typeof button.props.style === 'function'
            ? button.props.style({ hovered: false, pressed: false, focused: false }) : button.props.style;
        const style = Object.assign({}, ...[raw].flat(Infinity).filter(Boolean));
        // A touch target is a hit area, not a drawn size (DESIGN.md): the slot is never drawn at 44.
        expect(style.minWidth).toBeUndefined();
        expect(style.minHeight).toBeUndefined();
        expect(button.props.onLayout, 'the slot measures its glyph for the hit area').toBeTypeOf('function');
    });
    it('does not disclose a request when its mounted Action authority is unavailable', async () => {
        const screen = await renderScreen(
            <CollectionRequestPeek request={request} testID="slot" description="Fix the relay">
                <View testID="glyph" />
            </CollectionRequestPeek>,
        );
        expect(screen.findByTestId('glyph')).not.toBeNull();
        expect(screen.findByTestId('slot:peek')).toBeNull();

        await screen.pressByTestIdAsync('slot');
        expect(screen.findByTestId('slot:peek')).toBeNull();
    });
});
