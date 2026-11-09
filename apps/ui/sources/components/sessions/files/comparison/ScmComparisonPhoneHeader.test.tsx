import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

describe('ScmComparisonPhoneHeader', () => {
    it('offers one menu: each action once, the view and display choices as sections, no loose action row', async () => {
        const { ScmComparisonPhoneHeader } = await import('./ScmComparisonPhoneHeader');
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const onFind = vi.fn(); const onPropose = vi.fn(); const onDisplay = vi.fn();
        const screen = await renderScreen(<ScmComparisonPhoneHeader view="files" views={['files', 'walkthrough']}
            scope={{ options: [], current: null, currentLabel: 'Pending changes', fileCount: 3, onSelect: () => {} }}
            onSelectView={() => {}} onBack={() => {}} onStartReview={() => {}} onProposeCommits={onPropose}
            sections={[
                { id: 'find', items: [{ id: 'open', title: 'find.surface.changes' }], onSelect: onFind },
                { id: 'display', title: 'Display', items: [{ id: 'wrap', title: 'Wrap lines', checked: true }], onSelect: onDisplay },
            ]} />);
        const menu = screen.root.find((node) => node.type === DropdownMenu && node.props.testID === 'scm-comparison-phone-actions');
        const titles = (menu.props.items as { title: string }[]).map((item) => item.title);
        expect(titles.filter((title) => title === 'scmComparison.proposeCommits')).toHaveLength(1);
        expect(titles).toContain('find.surface.changes');
        expect(titles).toContain('Wrap lines');
        expect(menu.props.footer).toBeUndefined();
        expect(menu.props.showCategoryTitles).toBe(true);
        const idOf = (title: string) => (menu.props.items as { id: string; title: string }[]).find((item) => item.title === title)!.id;
        React.act(() => { menu.props.onSelect(idOf('find.surface.changes')); menu.props.onSelect(idOf('Wrap lines')); });
        expect(onFind).toHaveBeenCalledWith('open');
        expect(onDisplay).toHaveBeenCalledWith('wrap');
    });
    it('heads a phone Details tab as its one header: no strip, no Back of its own, the tab group\'s controls beside ⋯', async () => {
        const { View } = await import('react-native');
        const { ScmComparisonPhoneHeader } = await import('./ScmComparisonPhoneHeader');
        const { DetailsTabGroupPanel } = await import('@/components/appShell/panes/details/workspace/DetailsTabGroupPanel');
        const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
        const scope = { options: [], current: null, currentLabel: 'Pending changes', fileCount: 9, onSelect: () => {} };
        const pane = { setActiveDetailsTab: vi.fn(), pinDetailsTab: vi.fn(), unpinDetailsTab: vi.fn(), closeDetailsTab: vi.fn() };
        const walkthrough = { key: 'walk', kind: 'scmReview', title: 'Walkthrough', isPinned: true, isPreview: false,
            resource: { kind: 'scmReview' } };
        const render = (renderHeaderActions: (() => React.ReactNode) | null) => renderScreen(<SurfaceStateSizeProvider size="phone">
            <DetailsTabGroupPanel pane={pane as never} collapseSingleTabStrip
                group={{ id: 'group:1', tabKeys: ['walk'], activeTabKey: 'walk', tabs: [walkthrough as never], isFocused: true }}
                testIds={{ tab: (key: string) => `strip-tab-${key}` }}
                // The Session cockpit keeps Back in its own header and lends the strip nothing to carry.
                renderHeaderLeadingActions={() => null}
                renderHeaderActions={renderHeaderActions}
                renderTabContent={() => <ScmComparisonPhoneHeader view="walkthrough" views={['files', 'walkthrough']} scope={scope}
                    onSelectView={() => {}} onStartReview={() => {}} />} />
        </SurfaceStateSizeProvider>);
        const cockpit = await render(() => null);
        expect(cockpit.findAllHostsByTestId('strip-tab-walk')).toHaveLength(0);
        expect(cockpit.findByTestId('scm-comparison-phone-back')).toBeNull();
        expect(cockpit.findByTestId('scm-comparison-phone-more')).toBeTruthy();
        // Its title is the Details tab header's own title (the file viewer's size), wrapped by the scope picker.
        expect(cockpit.findByTestId('scm-comparison-phone-header.title')).toBeTruthy();
        expect(cockpit.findByTestId('scm-comparison-phone-scope')).toBeTruthy();
        // What the strip's chip offered (unpin, close) is in this header's ⋯, and acts on the tab.
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const menu = cockpit.root.find((node) => node.type === DropdownMenu && node.props.testID === 'scm-comparison-phone-actions');
        const rows = menu.props.items as { id: string; title: string }[];
        expect(rows.map((row) => row.title)).toEqual(expect.arrayContaining(['session.detailsPanel.unpinTabA11y', 'session.detailsPanel.closeTabA11y']));
        await React.act(async () => { menu.props.onSelect(rows.find((row) => row.title === 'session.detailsPanel.closeTabA11y')!.id); });
        await vi.waitFor(() => expect(pane.closeDetailsTab).toHaveBeenCalledWith('walk'));
        // A pane that does lend a control (its close) has it drawn once, in this header, not on a strip above it.
        const lending = await render(() => <View testID="pane-close" />);
        expect(lending.findAllHostsByTestId('strip-tab-walk')).toHaveLength(0);
        expect(lending.findAllHostsByTestId('pane-close')).toHaveLength(1);
    });
});
