import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { View } from 'react-native';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { HomeHero, useHomeHeroFrame } from './HomeHero';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';
import { atmosphereStageStore } from '@/components/atmosphere/atmosphereStage';

it('names Home with its level-one heading', async () => {
    function Home() {
        const frame = useHomeHeroFrame({ active: true, focused: true, phone: false });
        return <HomeHero title="Good evening" phone={false} paneHeight={frame.pane.height} rise={false}
            suggestions="none" showComposer={false} frame={frame} />;
    }
    const screen = await renderScreen(<Home />);
    try {
        const headings = screen.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'header');
        expect(headings.map(node => [node.props.children, node.props['aria-level']])).toEqual([['Good evening', 1]]);
    } finally { await screen.unmount(); }
});

it('reports an excluded visible unfocused Home without a headline, and withdraws its backing when hidden', async () => {
    function Home() {
        const frame = useHomeHeroFrame({ active: false, focused: false, phone: false });
        return <View testID="excluded-home" ref={frame.paneRef} onLayout={frame.measure} />;
    }
    const scene = (visible: boolean) => <DestinationInstanceContext.Provider value={{
        tabId: 'excluded-home', ref: { kind: 'home', params: {} }, pathname: '/', visible, focused: false, isFocused: () => false,
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
