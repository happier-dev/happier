import { describe, expect, it } from 'vitest';

import { lightTheme, darkTheme } from '@/theme';

import {
    createDesktopActivityOverlayChromeStyle,
    createDesktopActivityOverlayInteriorSurfaceStyle,
} from './DesktopActivityOverlayChrome';

describe('createDesktopActivityOverlayChromeStyle', () => {
    it('renders a borderless dense surface for the premium overlay chrome', () => {
        const floatingCollapsed = createDesktopActivityOverlayChromeStyle(lightTheme as never, {
            visualMode: 'floating_overlay',
            tone: 'collapsed',
        });
        const notchExpanded = createDesktopActivityOverlayChromeStyle(darkTheme as never, {
            visualMode: 'notch_integrated',
            tone: 'expanded',
        });

        expect(floatingCollapsed).toMatchObject({
            borderWidth: 0,
            borderColor: 'transparent',
            borderRadius: 24,
            backgroundColor: 'rgba(5, 5, 5, 0.965)',
        });
        expect(notchExpanded).toMatchObject({
            borderWidth: 0,
            borderColor: 'transparent',
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
            borderBottomLeftRadius: 28,
            borderBottomRightRadius: 28,
            backgroundColor: 'transparent',
        });
    });

    it('keeps the premium chrome flat enough to avoid a floating-card silhouette', () => {
        const style = createDesktopActivityOverlayChromeStyle(darkTheme as never, {
            visualMode: 'notch_integrated',
            tone: 'expanded',
        });

        expect(style).toMatchObject({
            borderWidth: 0,
            borderColor: 'transparent',
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
            borderBottomLeftRadius: 28,
            borderBottomRightRadius: 28,
            backgroundColor: 'transparent',
        });
        expect(Object.keys(style).filter((key) => key === 'boxShadow' || key.startsWith('shadow') || key === 'elevation')).toEqual([]);
    });

    it('keeps interior controls nearly fused into the shell instead of reading like separate slabs', () => {
        const notchAction = createDesktopActivityOverlayInteriorSurfaceStyle(darkTheme as never, {
            visualMode: 'notch_integrated',
            kind: 'action',
        });
        const floatingBadge = createDesktopActivityOverlayInteriorSurfaceStyle(lightTheme as never, {
            visualMode: 'floating_overlay',
            kind: 'badge',
        });

        expect(notchAction).toMatchObject({
            borderWidth: 0,
            borderColor: 'transparent',
            backgroundColor: 'rgba(5, 5, 5, 0.985)',
        });
        expect(floatingBadge).toMatchObject({
            borderWidth: 0,
            borderColor: 'transparent',
            backgroundColor: 'rgba(5, 5, 5, 0.955)',
        });
    });
});
