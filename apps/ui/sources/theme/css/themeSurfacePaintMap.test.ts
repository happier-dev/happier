import { describe, expect, it, vi } from 'vitest';
import { parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import type { SurfaceAddress, ThemeSurfacePaintDescriptor } from '@happier-dev/plugin-sdk/ui';
import { glassPresetMaterials, resolveGlassSurfaceMaterial } from '@/components/ui/glass/glassMaterial';
import type { GlassSurfaceCompositionContext } from '@/components/sessions/agentInput/composerSurfaceStyle';

import { isThemeProfilePublicTokenId } from '../profiles/themeProfileTokenRegistry';
import type { ThemeProfileV1 } from '../profiles/themeProfileTypes';

// The material branch is platform-owned; keep all profile and paint logic real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function document(overrides: ThemeProfileV1['overrides'] = { light: {}, dark: {} }) {
    const parsed = parseThemeProfileDocument({
        schemaVersion: 1, id: 'paint_map_test', name: 'Paint map',
        createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z',
        base: { light: 'light', dark: 'dark' }, overrides,
    });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.document;
}

function roles(map: readonly ThemeSurfacePaintDescriptor[], address: SurfaceAddress) {
    const found = map.find(entry => entry.address.surface === address.surface
        && entry.address.part === address.part && entry.address.state === address.state);
    expect(found, JSON.stringify(address)).toBeDefined();
    return found!.paintRoles;
}

const solidComposerMaterial: GlassSurfaceCompositionContext = {
    settings: { glassSurfaceMaterials: glassPresetMaterials('solid') }, environment: {}, web: true,
    group: 'card', nested: true, plane: false, noCoat: false, enabled: true, shellHeld: false,
    capability: 'solid', material: { blur: 'off', opacity: 1 }, inheritsTranslucentMaterial: false,
    hasNativeBackdrop: false, tintsWithoutBlur: false, panel: false,
};

describe('projectThemeSurfacePaintMap', () => {
    it('names addressed paint with the readable surface name for inspector captions', async () => {
        const { projectThemeSurfacePaintMap } = await import('./themeSurfacePaintMap');
        expect(projectThemeSurfacePaintMap(document(), 'light').find(entry =>
            entry.address.surface === 'session-row' && entry.address.part === 'title')?.label).toBe('session list · title');
    });

    it('does not claim a solid token is the final composer paint when the material context is unknown', async () => {
        const { projectThemeSurfacePaintMap } = await import('./themeSurfacePaintMap');
        expect(roles(projectThemeSurfacePaintMap(document(), 'light'),
            { surface: 'composer', part: 'root' })).toEqual([{ facet: 'background', source: { kind: 'fixed' } }]);
    });

    it('does not attribute supplied code-header content ink to the addressed wrapper', async () => {
        const { projectThemeSurfacePaintMap } = await import('./themeSurfacePaintMap');
        expect(roles(projectThemeSurfacePaintMap(document(), 'light'),
            { surface: 'code-block', part: 'header' })).toEqual([{ facet: 'background', source: { kind: 'fixed' } }]);
    });

    it('projects the actual composed coat while preserving direct solid and canonical fixed glass branches', async () => {
        const { projectThemeSurfacePaintMap } = await import('./themeSurfacePaintMap');
        const requested = document({ light: {}, dark: { 'control.input.background': '#445566' } });
        const context = { composerSurfaceStyle: 'standard' as const, composerMaterial: solidComposerMaterial };
        expect(roles(projectThemeSurfacePaintMap(requested, 'dark', context), { surface: 'composer', part: 'root' })).toEqual([{
            facet: 'background', source: { kind: 'token', ref: 'control.input.background' },
        }]);
        const settings = { glassSurfaceMaterials: glassPresetMaterials('everywhere') };
        const environment = { desktopWindow: true, nativeWindowMaterialLive: true };
        const material = resolveGlassSurfaceMaterial(settings, 'card', environment).material;
        expect(material.opacity).toBeLessThan(1);
        const coated = { ...context, composerMaterial: { ...solidComposerMaterial, settings, environment, material, capability: 'webBlur' as const } };
        expect(roles(projectThemeSurfacePaintMap(requested, 'dark', coated), { surface: 'composer', part: 'root' })).toEqual([{
            facet: 'background', source: { kind: 'derived', from: ['control.input.background', 'surface.base'] },
        }]);
        const glass = { ...context, composerSurfaceStyle: 'glass' as const };
        expect(roles(projectThemeSurfacePaintMap(document(), 'dark', glass), { surface: 'composer', part: 'root' })).toEqual([{
            facet: 'background', source: { kind: 'fixed' },
        }]);
        const elevated = document({ light: {}, dark: { 'surface.elevated': '#303030' } });
        expect(roles(projectThemeSurfacePaintMap(elevated, 'dark', glass), { surface: 'composer', part: 'root' })).toEqual([{
            facet: 'background', source: { kind: 'derived', from: ['surface.elevated'] },
        }]);
    });

    it('uses the requested profile and retains the authored-alpha material branch across cached reads', async () => {
        const { projectThemeSurfacePaintMap } = await import('./themeSurfacePaintMap');
        const requested = document({ light: {}, dark: { 'message.user.background': '#303030' } });
        const opaque = projectThemeSurfacePaintMap(requested, 'dark');
        expect(roles(opaque, { surface: 'user-bubble', part: 'root' })).toEqual([{
            facet: 'background', source: { kind: 'derived', from: ['message.user.background', 'surface.selected'] },
        }]);
        const authoredAlpha = document({ light: {}, dark: { 'message.user.background': 'rgba(48, 48, 48, 0.5)' } });
        expect(roles(projectThemeSurfacePaintMap(authoredAlpha, 'dark'), { surface: 'user-bubble', part: 'root' })).toEqual([{
            facet: 'background', source: { kind: 'token', ref: 'message.user.background' },
        }]);
        expect(roles(projectThemeSurfacePaintMap(requested, 'dark'), { surface: 'user-bubble', part: 'root' })).toEqual(
            roles(opaque, { surface: 'user-bubble', part: 'root' }),
        );
    });

    it('reports the actual off-switch thumb token and leaves instance-dependent title ink fixed', async () => {
        const { projectThemeSurfacePaintMap } = await import('./themeSurfacePaintMap');
        const map = projectThemeSurfacePaintMap(document({ light: {
            'control.switch.thumb.active': '#184261', 'control.switch.thumb.inactive': '#abcdef',
        }, dark: {} }), 'light');
        expect(roles(map, { surface: 'switch', part: 'thumb' })).toContainEqual({
            facet: 'background', source: { kind: 'token', ref: 'control.switch.thumb.active' },
        });
        expect(roles(map, { surface: 'session-row', part: 'title', state: 'selected' })).toContainEqual({
            facet: 'foreground', source: { kind: 'fixed' },
        });
        expect(roles(map, { surface: 'user-bubble', part: 'text' })).toEqual([{
            facet: 'foreground', source: { kind: 'fixed' },
        }]);
    });

    it('returns populated paint roles whose editable references belong to the canonical token registry', async () => {
        const { projectThemeSurfacePaintMap } = await import('./themeSurfacePaintMap');
        const map = projectThemeSurfacePaintMap(document({ light: {}, dark: {
            'surface.elevated': '#303030', 'text.primary': '#cdd6f4',
        } }), 'dark', { composerSurfaceStyle: 'glass' });
        expect(map.length).toBeGreaterThan(0);
        for (const entry of map) {
            expect(entry.paintRoles.length, entry.selector).toBeGreaterThan(0);
            for (const role of entry.paintRoles) {
                const refs = role.source.kind === 'token' ? [role.source.ref]
                    : role.source.kind === 'derived' ? role.source.from : [];
                if (role.source.kind === 'derived') expect(refs.length, entry.selector).toBeGreaterThan(0);
                for (const ref of refs) expect(isThemeProfilePublicTokenId(ref), `${entry.selector}: ${ref}`).toBe(true);
            }
        }
    });
});
