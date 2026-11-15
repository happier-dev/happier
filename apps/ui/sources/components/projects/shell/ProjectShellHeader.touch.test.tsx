import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';
import { layoutHitArea, hitAreaOverlap } from '@/dev/testkit/harness/hitFrameReach';

installUiListsCommonModuleMocks();
const { ProjectShellHeader } = await import('./ProjectShellHeader');
afterEach(async () => { vi.unstubAllGlobals(); await standardCleanup(); });

it('splits the header actions\' 6 px gap between neighbours, so no two finger frames overlap', async () => {
    vi.stubGlobal('navigator', { maxTouchPoints: 1 });
    const screen = await renderScreen(<ProjectShellHeader projectName="Project" checkout={null} pages={[]}
        activePage="overview" onSelectPage={() => {}} onNewSession={() => {}}
        menuActions={[{ id: 'rename', title: 'Rename', onSelect: () => {} }]} />);
    // A band narrower than the wide threshold draws the compact icon actions, the ones with a side reach.
    await act(async () => screen.findHostByTestId('project-shell-header')!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 800, height: 56 } } }));
    const add = await layoutHitArea(() => screen.findHostByTestId('project-shell-header.newSession'), { width: 32, height: 32 });
    const menu = await layoutHitArea(() => screen.findHostByTestId('project-shell-header.menu.trigger'), { width: 32, height: 32 });
    const gapHalf = 3;
    expect(add.insets).toMatchObject({ left: gapHalf, right: gapHalf });
    expect(menu.insets).toMatchObject({ left: gapHalf, right: gapHalf });
    expect(hitAreaOverlap(add, menu, { axis: 'horizontal', gap: 6 })).toBe(0);
});
