import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { View } from 'react-native';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { HomeHero, useHomeHeroFrame } from './HomeHero';
import { HomePlanet } from '@/components/atmosphere/HomePlanet';
import { PlanetCanvas } from '@/components/atmosphere/PlanetCanvas';
import type { HomePlanetPlacement } from '@/components/atmosphere/homePlanetPlacement';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';
import { atmosphereStageStore } from '@/components/atmosphere/atmosphereStage';

it('reports an excluded visible unfocused Home without a headline, and withdraws its backing when hidden', async () => {
    function Home() {
        const frame = useHomeHeroFrame({ active: false, focused: false, phone: false });
        return <View testID="excluded-home" ref={frame.paneRef} onLayout={frame.measure} />;
    }
    const scene = (visible: boolean) => <DestinationInstanceContext.Provider value={{
        tabId: 'excluded-home', ref: { kind: 'home', params: {} }, pathname: '/', visible, focused: false,
    }}><Home /></DestinationInstanceContext.Provider>;
    const screen = await renderScreen(scene(true), { createNodeMock: () => ({
        measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(400, 20, 600, 800),
    }) });
    try {
        await act(async () => { screen.findHostByTestId('excluded-home')!.props.onLayout(); });
        expect(atmosphereStageStore.get().excludedPanes).toEqual([expect.objectContaining({
            surface: 'home', geometry: expect.objectContaining({ rect: { x: 400, y: 20, width: 600, height: 800 } }),
        })]);
        expect(atmosphereStageStore.get().stage).toBeNull();
        await screen.update(scene(false));
        expect(atmosphereStageStore.get().excludedPanes).toHaveLength(0);
    } finally { await screen.unmount(); }
});

it('keeps a mounted planet fade aligned with the section moved by Corner → Rise → Side → Rise', async () => {
    const pane = { width: 1104, height: 852 };
    let nextTop = 472;
    function Home({ placement }: { placement: HomePlanetPlacement }) {
        const frame = useHomeHeroFrame({ active: true, focused: true, phone: false });
        return <View testID="measured-home" ref={frame.paneRef} onLayout={frame.measure}>
            <HomePlanet pane={frame.pane} hero={frame.hero} placement={placement} style="rich" digits
                theme="dark" phone={false} hidden={false} leave="fade" reducedMotion={false} />
            <HomeHero title="Home" phone={false} paneHeight={frame.pane.height} rise={placement === 'rise'}
                suggestions="links" showComposer={false} frame={frame} />
            <View testID="next-section" ref={frame.nextRef} onLayout={frame.measure} />
        </View>;
    }
    // Native/browser measurement is the boundary. Rise changes padding, not content-box size:
    // web's ResizeObserver emits no event for the hero, its headline or the moved sibling.
    const screen = await renderScreen(<Home placement="corner" />, { createNodeMock: element => ({
        measureInWindow(done: (x: number, y: number, width: number, height: number) => void) {
            if (element.props.testID === 'measured-home') done(328, 40, pane.width, pane.height);
            else if (element.props.testID === 'next-section') done(328, 40 + nextTop, pane.width, 40);
            else done(328, 374, pane.width, 36);
        },
    }) });
    try {
        await act(async () => { screen.findHostByTestId('measured-home')!.props.onLayout(); });
        const mountedCanvas = screen.findByType(PlanetCanvas);
        expect(mountedCanvas.props.fade).toBeUndefined();
        for (const [placement, position] of [['rise', 672], ['side', 472], ['rise', 752]] as const) {
            nextTop = position;
            await screen.update(<Home placement={placement} />);
            const canvas = screen.findByType(PlanetCanvas);
            expect(canvas).toBe(mountedCanvas);
            if (placement === 'rise') {
                // The ordered fade ends before the section in the CURRENT layout, not the old hero.
                expect(canvas.props.fade.to).toBe(nextTop - 6);
                expect(canvas.props.options.view.h).toBe(canvas.props.height);
            } else expect(canvas.props.fade).toBeUndefined();
        }
    } finally { await screen.unmount(); }
});

describe('Home atmosphere geometry while the composer is focused', () => {
    it('holds a prefilled draft through shrink and growth, updates on resize, then catches up on blur', async () => {
        const hook = await renderHook(() => useHomeHeroFrame({ active: true, focused: true, phone: true }));
        let paneHeight = 844;
        let composerHeight = 180;
        let composerTop = 300;
        const frame = hook.getCurrent();
        // Native measurement is the external boundary; the hook's geometry and store stay real.
        const node = (box: () => { x: number; y: number; width: number; height: number }) => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => {
                const value = box(); done(value.x, value.y, value.width, value.height);
            },
        }) as View;
        frame.paneRef.current = node(() => ({ x: 0, y: 0, width: 390, height: paneHeight }));
        frame.headlineRef.current = node(() => ({ x: 0, y: 200, width: 390, height: 40 }));
        frame.composerRef.current = node(() => ({ x: 16, y: composerTop, width: 358, height: composerHeight }));
        frame.suggestionsRef.current = node(() => ({ x: 16, y: composerTop + composerHeight + 12, width: 358, height: 32 }));
        frame.nextRef.current = node(() => ({ x: 16, y: composerTop + composerHeight + 100, width: 358, height: 80 }));
        const measure = async () => act(async () => { hook.getCurrent().measure(); });
        await measure();
        const before = hook.getCurrent().hero;
        await act(async () => { hook.getCurrent().onComposerFocus(); });
        composerHeight = 70;
        composerTop = 285;
        await measure();
        expect(hook.getCurrent().hero).toEqual(before);
        composerHeight = 230;
        await measure();
        expect(hook.getCurrent().hero).toEqual(before);
        paneHeight = 600;
        await measure();
        expect(hook.getCurrent().hero?.aboveBottom).toBe(559);
        composerHeight = 90;
        await measure();
        expect(hook.getCurrent().hero?.aboveBottom).toBe(559);
        await act(async () => { hook.getCurrent().onComposerBlur(); });
        expect(hook.getCurrent().hero?.aboveBottom).toBe(419);
        await hook.unmount();
    });
});
