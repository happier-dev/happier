import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks({
    storage: async (original) => original(),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

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
        const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
        const screen = await renderScreen(<NewSessionWizardDropdownSelectionItem
            testID="trigger"
            title="Select Thing"
            subtitle="Current Thing"
            icon={null}
            items={[{ id: 'thing', title: 'Current Thing' }]}
            selectedId="thing"
            boundaryRef={{ current: null }}
            onSelect={() => {}}
        />);

        const dropdown = screen.findByType(DropdownMenu);
        expect(dropdown.props.itemTrigger).toMatchObject({
            title: 'Select Thing',
            subtitle: 'Current Thing',
            showSelectedDetail: false,
            showSelectedSubtitle: false,
            itemProps: { testID: 'trigger' },
        });
    });

    it('retires pending work when the mounted wizard popover closes', async () => {
        const { AgentInputContentPopover } = await import('@/components/sessions/agentInput/components/AgentInputContentPopover');
        const { NewSessionWizardPopoverItem } = await import('./NewSessionWizardAdaptiveSelection');
        const retirePendingWork = vi.fn();
        const screen = await renderScreen(<NewSessionWizardPopoverItem
            testID="trigger"
            title="Run on"
            icon={null}
            boundaryRef={{ current: null }}
            popover={{
                renderContent: () => null,
                onRequestClose: retirePendingWork,
            }}
        />);

        await screen.pressByTestIdAsync('trigger');
        const popover = screen.findByType(AgentInputContentPopover);
        popover.props.onRequestClose();

        expect(retirePendingWork).toHaveBeenCalledOnce();
    });
});
