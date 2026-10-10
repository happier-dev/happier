/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import { applyGlassDocumentPresentation, shouldRevealNativeGlassCanvas } from './glassDocumentPresentation';
import { applyWebRootCanvasPresentation } from '@/theme/useWebRootCanvasPresentation';
import { glassPresetMaterials } from './glassMaterial';
import { applyThemeRuntimeSelection, type ThemeRuntimeUnistylesAdapter } from '@/theme/profiles/themeProfileRuntime';
import { darkTheme, lightTheme } from '@/theme';
import { resolveGlassSurfaceColor } from './useGlassSurfaceColor';

describe('live document material boundary', () => {
    it('resolves an authored web field variable before alpha inspection and keeps solid and translucent authoring exact', () => {
        const variable = '--colors-input-background';
        const color = `var(${variable})`;
        const ink = 'rgba(235, 230, 225, 0.1)';
        const before = document.documentElement.style.getPropertyValue(variable);
        const settings = { glassSurfaceMaterials: glassPresetMaterials('everywhere') };
        const environment = { desktopWindow: true, nativeWindowMaterialLive: true };
        try {
            document.documentElement.style.setProperty(variable, '#171515');
            expect(resolveGlassSurfaceColor(color, 'floating', settings, environment, true, true, ink)).toBe(ink);
            expect(resolveGlassSurfaceColor(color, 'floating', settings, { ...environment, reduceTransparency: true }, true, true, ink)).toBe(color);
            expect(resolveGlassSurfaceColor(color, 'floating', settings, environment, false, true, ink)).toBe(color);
            document.documentElement.style.setProperty(variable, 'rgba(23, 21, 21, 0.07)');
            expect(resolveGlassSurfaceColor(color, 'floating', settings, environment, true, true, ink)).toBe(color);
            document.documentElement.style.removeProperty(variable);
            expect(resolveGlassSurfaceColor(color, 'floating', settings, environment, true, true, ink)).toBe(color);
        } finally {
            if (before) document.documentElement.style.setProperty(variable, before);
            else document.documentElement.style.removeProperty(variable);
        }
    });
    it('keeps native backing visible when the real profile owner applies a web theme', () => {
        const doc = document.implementation.createHTMLDocument();
        doc.body.innerHTML = '<div id="root"></div>';
        const canvas = [doc.documentElement, doc.body, doc.getElementById('root')!];
        const stop = applyWebRootCanvasPresentation(doc, 'transparent');
        const registered: Record<'light' | 'dark', ReturnType<ThemeRuntimeUnistylesAdapter['getTheme']>> = { light: lightTheme, dark: darkTheme };
        // Model only Unistyles/SystemUI's DOM adapters; the profile and material owners stay real.
        applyThemeRuntimeSelection({
            platform: 'web', themePreference: 'dark', systemTheme: 'light',
            themeProfiles: { profiles: [], activeProfileIds: { light: null, dark: null } },
            unistylesRuntime: {
                getTheme: name => registered[name],
                updateTheme: (name, update) => { registered[name] = update(registered[name]); },
                setTheme: () => {}, setAdaptiveThemes: () => {},
                setRootViewBackgroundColor: color => { doc.documentElement.style.backgroundColor = color; },
            },
            setSystemBackgroundColor: color => { doc.body.style.backgroundColor = color; },
            recordBreadcrumb: () => {},
        });
        expect(canvas.map(node => node.style.backgroundColor)).toEqual(['transparent', 'transparent', 'transparent']);
        stop();
    });
    it('reveals native material only after application succeeds, restoring original canvas on flatten/unmount', () => {
        const doc = document.implementation.createHTMLDocument();
        doc.body.innerHTML = '<div id="root"></div>';
        const canvas = [doc.documentElement, doc.body, doc.getElementById('root')!];
        canvas.forEach(node => { node.style.backgroundColor = 'rgb(12, 14, 16)'; });
        const paint = (environment: Parameters<typeof shouldRevealNativeGlassCanvas>[0]) => applyWebRootCanvasPresentation(doc,
            shouldRevealNativeGlassCanvas(environment) ? 'transparent' : 'rgb(12, 14, 16)');
        const unavailable = paint({ desktopWindow: true, nativeWindowMaterialLive: false });
        expect(doc.body.style.backgroundColor).toBe('rgb(12, 14, 16)');
        unavailable();
        const live = paint({ desktopWindow: true, nativeWindowMaterialLive: true });
        expect(canvas.map(node => node.style.backgroundColor)).toEqual(['transparent', 'transparent', 'transparent']);
        live();
        expect(canvas.map(node => node.style.backgroundColor)).toEqual(['rgb(12, 14, 16)', 'rgb(12, 14, 16)', 'rgb(12, 14, 16)']);
        const reduced = paint({ desktopWindow: true, nativeWindowMaterialLive: true, reduceTransparency: true });
        expect(doc.body.style.backgroundColor).toBe('rgb(12, 14, 16)');
        reduced();
        const inactive = paint({ desktopWindow: true, nativeWindowMaterialLive: true, windowActive: false });
        expect(doc.body.style.backgroundColor).toBe('rgb(12, 14, 16)');
        inactive();
    });

    it('restores absent inline paint and an existing important background after a mounted canvas update', () => {
        const doc = document.implementation.createHTMLDocument();
        doc.body.innerHTML = '<div id="root"></div>';
        doc.documentElement.style.setProperty('background-color', 'red', 'important');
        const stop = applyWebRootCanvasPresentation(doc, darkTheme.colors.background.canvas);
        expect([doc.documentElement, doc.body, doc.getElementById('root')!].map(node => node.style.backgroundColor))
            .toEqual(['rgb(20, 18, 18)', 'rgb(20, 18, 18)', 'rgb(20, 18, 18)']);
        stop();
        expect(doc.documentElement.style.getPropertyValue('background-color')).toBe('red');
        expect(doc.documentElement.style.getPropertyPriority('background-color')).toBe('important');
        expect(doc.body.style.getPropertyValue('background-color')).toBe('');
        expect(doc.getElementById('root')!.style.getPropertyValue('background-color')).toBe('');
    });

    it('publishes exact zero-opacity custom values and avoids a second nested coat', () => {
        const doc = document.implementation.createHTMLDocument();
        const stop = applyGlassDocumentPresentation(doc, {
            glassSurfaceMaterials: { ...glassPresetMaterials('everywhere'), content: { blur: 'strong', opacity: 0 } },
        }, {});
        expect(doc.documentElement.style.getPropertyValue('--happier-glass-content-opacity')).toBe('0%');
        expect(doc.documentElement.style.getPropertyValue('--happier-glass-content-nested-opacity')).toBe('0%');
        expect(doc.documentElement.style.getPropertyValue('--happier-glass-content-blur')).toBe('24px');
        stop();
        expect(doc.documentElement.style.getPropertyValue('--happier-glass-content-opacity')).toBe('');
    });
});
