import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
// The platform decoder is the boundary; the media/host rendering path stays real.
vi.mock('expo-image', () => ({ Image: (props: object) => React.createElement('DecodedImage', props) }));

describe('MediaPicture shared host image', () => {
    it('draws validated native SVG text and reports its real parsed dimensions', async () => {
        const { MediaPicture } = await import('./MediaPicture');
        const onSize = vi.fn();
        const onError = vi.fn();
        const screen = await renderScreen(<MediaPicture
            kind="svg"
            uri="file:///drawing.svg"
            svgText={'<svg width="24" height="16"><circle cx="8" cy="8" r="4"/></svg>'}
            size={{ width: 48, height: 32 }}
            onIntrinsicSize={onSize}
            onError={onError}
        />);
        try {
            const drawing = screen.findByType('SvgAst');
            expect(React.isValidElement(drawing.props.ast.children[0])).toBe(true);
            const circle = drawing.props.ast.children[0].props;
            expect({ cx: circle.cx, cy: circle.cy, r: circle.r }).toEqual({ cx: 8, cy: 8, r: 4 });
            expect(drawing.props.override).toMatchObject({ width: 48, height: 32 });
            expect(onSize).toHaveBeenLastCalledWith({ width: 24, height: 16 });
            expect(onError).not.toHaveBeenCalled();
        } finally { await screen.unmount(); }
    });

    it('allows fit downscaling and preserves full resolution when zoom settles above fit', async () => {
        const { MediaPicture } = await import('./MediaPicture');
        const onSize = vi.fn();
        const onError = vi.fn();
        const props = { kind: 'image' as const, uri: 'file:///photo.png', size: { width: 300, height: 200 }, onIntrinsicSize: onSize, onError };
        const screen = await renderScreen(<MediaPicture {...props} />);
        try {
            expect(screen.findByType('DecodedImage').props.allowDownscaling).toBe(true);
            await act(async () => screen.findByType('DecodedImage').props.onLoad({ source: { width: 3000, height: 2000 } }));
            expect(onSize).toHaveBeenLastCalledWith({ width: 3000, height: 2000 });
            await act(async () => screen.update(<MediaPicture {...props} fullResolution />));
            expect(screen.findByType('DecodedImage').props.allowDownscaling).toBe(false);
            await act(async () => screen.findByType('DecodedImage').props.onError({ error: 'decoder failed' }));
            expect(onError).toHaveBeenLastCalledWith('decoder failed');
        } finally { await screen.unmount(); }
    });
});
