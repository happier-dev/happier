import * as React from 'react';
import { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';

installUiListsCommonModuleMocks();

const { ProjectShellHeader } = await import('./ProjectShellHeader');
const { SegmentedTabBar } = await import('@/components/ui/navigation/SegmentedTabBar');
const { AtmosphereBandBoundary } = await import('@/components/atmosphere/atmosphereBandBoundary');
const { atmosphereStageStore } = await import('@/components/atmosphere/atmosphereStage');

function header(pictureRoom: boolean) {
    return (
        <AtmosphereBandBoundary.Provider value={{ ref: undefined, onLayout: () => {}, onFocusChange: () => {}, pictureRoom }}>
            <ProjectShellHeader projectName="Project" checkout={null} pages={[]} activePage="overview"
                onSelectPage={() => {}} onNewSession={null} menuActions={[]} />
        </AtmosphereBandBoundary.Provider>
    );
}

describe('Project header band footprint', () => {
    afterEach(async () => {
        await act(async () => { atmosphereStageStore.setPictureShown(false); });
        await standardCleanup();
    });

    it('keeps the room a picture band needs from the first paint, so the picture arriving moves nothing', async () => {
        const screen = await renderScreen(header(true));
        const bandTop = () => StyleSheet.flatten(screen.findHostByTestId('project-shell-header')!.props.style).paddingTop;
        const planetStage = bandTop();
        expect(planetStage).toBeGreaterThan(0);
        await act(async () => { atmosphereStageStore.setPictureShown(true); });
        expect(bandTop()).toBe(planetStage);
    });

    it('opens no picture room where the surface will not show a picture', async () => {
        const screen = await renderScreen(header(false));
        expect(StyleSheet.flatten(screen.findHostByTestId('project-shell-header')!.props.style).paddingTop ?? 0).toBe(0);
    });

    it('sets the page tabs on their segmented track over the planet, as over a picture, and plain on the bare page', async () => {
        const pages = [{ id: 'overview', title: 'Overview', icon: 'house' as const, disabledReason: null },
            { id: 'code', title: 'Code', icon: 'code' as const, disabledReason: null }];
        const scene = (boundary: Readonly<{ planet?: boolean }> | null) => {
            const bar = <ProjectShellHeader projectName="Project" checkout={null} pages={pages} activePage="overview"
                onSelectPage={() => {}} onNewSession={null} menuActions={[]} />;
            return boundary ? <AtmosphereBandBoundary.Provider value={{ ref: undefined, onLayout: () => {}, onFocusChange: () => {}, ...boundary }}>
                {bar}</AtmosphereBandBoundary.Provider> : bar;
        };
        // The segmented track is the material the tabs read through; plain tabs have no track of their own.
        const presentation = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
            const tablist = screen.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'tablist')[0]!;
            // With overflow, the semantic tab row sits inside the painted track beside More.
            // Read its rendered backing ancestors, stopping at the bar rather than the page's band.
            for (let node = tablist.parent; node && node.type !== SegmentedTabBar; node = node.parent) {
                if (typeof node.type !== 'string') continue;
                const track = StyleSheet.flatten(node.props.style)?.backgroundColor;
                if (track !== undefined && track !== 'transparent') return 'segmented';
            }
            return 'plain';
        };
        const screen = await renderScreen(scene({ planet: true }));
        expect(presentation(screen)).toBe('segmented');
        await screen.update(scene({ planet: false }));
        expect(presentation(screen)).toBe('plain');
        await act(async () => { atmosphereStageStore.setPictureShown(true); });
        expect(presentation(screen)).toBe('segmented');
        await screen.update(scene(null));
        expect(presentation(screen)).toBe('plain');
    });
});
