import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

describe('NewSessionWizardAdaptiveSelection', () => {
    it('resolves explicit wizard presentation before auto presentation', async () => {
        const { resolveWizardAdaptivePresentation } = await import('./NewSessionWizardAdaptiveSelection');

        expect(resolveWizardAdaptivePresentation('dropdown', 'expanded')).toBe('compact');
        expect(resolveWizardAdaptivePresentation('list', 'compact')).toBe('expanded');
        expect(resolveWizardAdaptivePresentation('auto', 'compact')).toBe('compact');
        expect(resolveWizardAdaptivePresentation(undefined, 'expanded')).toBe('expanded');
    });

    it('renders compact dropdown triggers with selected value as subtitle only', async () => {
        const { NewSessionWizardDropdownSelectionItem } = await import('./NewSessionWizardAdaptiveSelection');
        const screen = await renderScreen(<NewSessionWizardDropdownSelectionItem
            testID="trigger"
            title="Select Thing"
            subtitle="Current Thing"
            icon={null}
            items={[{ id: 'thing', title: 'Current Thing' }]}
            selectedId="thing"
            boundaryRef={{ current: null } as any}
            onSelect={() => {}}
        />);

        const dropdown = screen.findByType('DropdownMenu' as any);
        expect(dropdown.props.itemTrigger).toMatchObject({
            title: 'Select Thing',
            subtitle: 'Current Thing',
            showSelectedDetail: false,
            showSelectedSubtitle: false,
            itemProps: { testID: 'trigger' },
        });
    });
});
