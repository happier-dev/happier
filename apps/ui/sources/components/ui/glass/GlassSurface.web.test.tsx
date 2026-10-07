import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

// The web renderer is the platform boundary; material policy, settings and reconciliation stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

let GlassSurface: typeof import('./GlassSurface')['GlassSurface'];
let glassSurfacePlaneStyle: typeof import('./glassSurfacePaint')['glassSurfacePlaneStyle'];
let storage: typeof import('@/sync/domains/state/storage')['storage'];
let resolvePreset: typeof import('./glassMaterial')['resolveGlassPresetSettingsDelta'];
let previousState: ReturnType<typeof storage.getState>;
beforeAll(async () => {
    ({ storage } = await import('@/sync/domains/state/storage'));
    ({ GlassSurface } = await import('./GlassSurface'));
    ({ glassSurfacePlaneStyle } = await import('./glassSurfacePaint'));
    ({ resolveGlassPresetSettingsDelta: resolvePreset } = await import('./glassMaterial'));
    previousState = storage.getState();
});
afterEach(() => {
    standardCleanup();
    act(() => storage.setState(previousState, true));
});

function DraftInput() {
    const [value, setValue] = React.useState('');
    return React.createElement('DraftInput', { testID: 'draft', value, onChangeText: setValue });
}

function hasBackdrop(node: ReactTestInstance): boolean {
    if (typeof node.type !== 'string') return false;
    const style = flattenTestStyle(node.props.style) as Record<string, unknown> | null;
    const filter = style?.backdropFilter ?? style?.WebkitBackdropFilter;
    return typeof filter === 'string' && filter !== 'none';
}

/** A CSS backdrop-filter element is a backdrop root: a descendant surface can only blur what it contains. */
function backdropAncestors(node: ReactTestInstance): ReactTestInstance[] {
    const out: ReactTestInstance[] = [];
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (hasBackdrop(parent)) out.push(parent);
    }
    return out;
}

function useAutoPreset() {
    act(() => storage.setState({ settings: { ...previousState.settings, ...resolvePreset(previousState.settings, 'auto') } }));
}

describe('web glass material', () => {
    it('blurs behind a floating surface without making its content a backdrop root', async () => {
        useAutoPreset();
        const screen = await renderScreen(
            <GlassSurface testID="outer" surfaceGroup="floating">
                <GlassSurface testID="inner" surfaceGroup="floating"><DraftInput /></GlassSurface>
            </GlassSurface>,
        );
        // The material really blurs on web (the floating group keeps its blur in a browser)...
        expect(screen.findAll(hasBackdrop).length).toBeGreaterThan(0);
        // ...yet neither the content nor a nested floating surface sits inside a backdrop root, so a menu,
        // tooltip or nested popover inside this surface blurs the page behind it, not an empty plane.
        const draft = screen.findHostByTestId('draft');
        expect(draft).not.toBeNull();
        expect(backdropAncestors(draft!).length).toBe(0);
    });

    it('keeps the content mounted when the user turns blur off and back on', async () => {
        useAutoPreset();
        const screen = await renderScreen(<GlassSurface surfaceGroup="floating"><DraftInput /></GlassSurface>);
        await act(async () => { screen.changeTextByTestId('draft', 'keep this draft'); });
        for (const preset of ['solid', 'auto'] as const) {
            act(() => storage.setState({ settings: { ...storage.getState().settings, ...resolvePreset(storage.getState().settings, preset) } }));
            expect(screen.findHostByTestId('draft')?.props.value).toBe('keep this draft');
            expect(screen.findAll(hasBackdrop).length > 0).toBe(preset === 'auto');
        }
    });

    it('never turns a shell plane into a backdrop root for the surfaces it holds', () => {
        // A base plane lies on the window canvas: there is nothing behind it a CSS blur could reach (the
        // window material is native), so a backdrop-filter there only cuts its descendants off the page.
        for (const group of ['chrome', 'sidebar', 'content'] as const) {
            const style = glassSurfacePlaneStyle('#ffffff', group) as Record<string, unknown>;
            expect(style.backdropFilter ?? 'none').toBe('none');
            expect(style.WebkitBackdropFilter ?? 'none').toBe('none');
        }
    });
});
