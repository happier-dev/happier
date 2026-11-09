import * as React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks();

const { SessionFullscreenPaneSafeAreaView } = await import('./SessionFullscreenPaneSafeAreaView');
const { SessionCockpitFullscreenSurface } = await import('@/components/workspaceCockpit/session/SessionCockpitFullscreenSurface');
const { GlassSurface } = await import('@/components/ui/glass/GlassSurface');
const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');

let mounts = 0;
function Content() {
    React.useEffect(() => { mounts++; }, []);
    return null;
}

describe('Session fullscreen layout material', () => {
    beforeEach(() => { mounts = 0; });

    it.each(['route', 'cockpit'] as const)('%s inherits its page reading coat and keeps content mounted when the backdrop withdraws', async (layout) => {
        const content = layout === 'route'
            ? <SessionFullscreenPaneSafeAreaView testID="fullscreen"><Content /></SessionFullscreenPaneSafeAreaView>
            : <SessionCockpitFullscreenSurface screenTestID="fullscreen"><Content /></SessionCockpitFullscreenSurface>;
        const scene = (backing: 'wallpaper' | 'none', preset: 'everywhere' | 'solid' = 'everywhere') => (
            <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials(preset) }}>
                <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: backing }}>
                    <GlassSurface plane surfaceGroup="content" atmosphereCoat={backing === 'none' ? undefined : 'reading'}>
                        {content}
                    </GlassSurface>
                </GlassRuntimeEnvironmentProvider>
            </GlassMaterialSettingsProvider>
        );
        const screen = await renderScreen(scene('wallpaper'));
        const ground = () => flattenTestStyle(screen.findHostByTestId('fullscreen')?.props.style).backgroundColor;
        expect(ground()).toBe('transparent');
        await screen.update(scene('none'));
        expect(ground()).not.toBe('transparent');
        await screen.update(scene('wallpaper', 'solid'));
        expect(ground()).not.toBe('transparent');
        expect(mounts).toBe(1);
    });
});
