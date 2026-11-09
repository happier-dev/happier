import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

const { GlassSurface } = await import('@/components/ui/glass/GlassSurface');
const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
const { useWidgetAreaFrame } = await import('./useWidgetFrameStyle');

/** One area widget: the person's own frame choice, or none (a preset or placement default). */
function FrameOf(props: Readonly<{ override: 'card' | 'plain' | null }>): React.ReactElement {
    return React.createElement('FrameOf', { value: useWidgetAreaFrame('companion', props.override) });
}

async function frameOn(behind: 'none' | 'band' | 'wallpaper', override: 'card' | 'plain' | null, coat?: 'reading' | 'opaque'): Promise<unknown> {
    const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: behind }}>
        <GlassSurface plane surfaceGroup="content" finishRole={null} {...(coat ? { atmosphereCoat: coat } : {})}>
            <FrameOf override={override} />
        </GlassSurface>
    </GlassRuntimeEnvironmentProvider>);
    return screen.tree.find(node => (node.type as unknown) === 'FrameOf').props.value;
}

afterEach(() => { standardCleanup(); });

describe('a widget area frame', () => {
    it('stands a widget with no frame choice on Elements where the cleared page is the Wallpaper picture itself', async () => {
        expect(await frameOn('wallpaper', null)).toEqual({ style: 'card', areaDefault: 'card' });
    });

    it('keeps a frame the person chose, Plain included, over the picture', async () => {
        expect(await frameOn('wallpaper', 'plain')).toEqual({ style: 'plain', areaDefault: 'card' });
    });

    it('stands a widget on its card where a Project page draws its planet behind it, keeping a Plain choice (QA-PROJECTS D8)', async () => {
        const { AtmosphereBandBoundary } = await import('@/components/atmosphere/atmosphereBandBoundary');
        const onPlanet = async (override: 'card' | 'plain' | null) => {
            const screen = await renderScreen(<AtmosphereBandBoundary.Provider value={{ ref: undefined, onLayout: () => {}, onFocusChange: () => {}, planet: true }}>
                <FrameOf override={override} />
            </AtmosphereBandBoundary.Provider>);
            return screen.tree.find(node => (node.type as unknown) === 'FrameOf').props.value;
        };
        expect(await onPlanet(null)).toEqual({ style: 'card', areaDefault: 'card' });
        expect(await onPlanet('plain')).toEqual({ style: 'plain', areaDefault: 'card' });
    });

    it('keeps the placement default on the page colour, under a Horizon band and on a session coat', async () => {
        const plain = { style: 'plain', areaDefault: 'plain' };
        expect(await frameOn('none', null)).toEqual(plain);
        // Below a Horizon band the layer paints the page colour behind the cleared plane.
        expect(await frameOn('band', null)).toEqual(plain);
        expect(await frameOn('wallpaper', null, 'reading')).toEqual(plain);
        expect(await frameOn('wallpaper', null, 'opaque')).toEqual(plain);
    });
});
