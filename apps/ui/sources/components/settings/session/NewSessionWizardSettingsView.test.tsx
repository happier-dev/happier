import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';

const setPresentation = vi.fn();
const setColumnsEnabled = vi.fn();

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSettingMutable: (name: string) => {
                if (name === 'newSessionWizardSectionPresentationV1') {
                    return [{ models: 'dropdown' }, setPresentation];
                }
                if (name === 'newSessionWizardColumnsEnabled') {
                    return [false, setColumnsEnabled];
                }
                return [null, vi.fn()];
            },
        },
    });
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children?: React.ReactNode }) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement(
        React.Fragment,
        null,
        props.itemTrigger ? React.createElement('Item', { ...props.itemTrigger, ...(props.itemTrigger.itemProps ?? {}) }) : null,
        ...(props.items ?? []).map((item: any) => React.createElement('Item', {
            key: `${props.itemTrigger?.title ?? 'unknown'}:${item.id}`,
            title: `DropdownItem:${props.itemTrigger?.title ?? 'unknown'}:${item.title}`,
            onPress: () => props.onSelect?.(item.id),
        })),
    ),
}));

describe('NewSessionWizardSettingsView', () => {
    it('renders every wizard selection section and updates one section without dropping the others', async () => {
        const { NewSessionWizardSettingsView } = await import('./NewSessionWizardSettingsView');
        const screen = await renderSettingsView(React.createElement(NewSessionWizardSettingsView));

        expect(screen.findRowByTitle('Select AI Profile')).toBeTruthy();
        expect(screen.findRowByTitle('Select AI Backend')).toBeTruthy();
        expect(screen.findRowByTitle('Select AI Model')).toBeTruthy();
        expect(screen.findRowByTitle('Select Machine')).toBeTruthy();
        expect(screen.findRowByTitle('Select Working Directory')).toBeTruthy();
        expect(screen.findRowByTitle('Select Permission Mode')).toBeTruthy();

        const rows = screen.findAllByType('Item' as any).filter((item) => typeof item.props.testID === 'string');
        expect(rows.map((row) => [row.props.testID, row.props.subtitle])).toEqual([
            ['settings-new-session-wizard-columns', 'Stack every wizard selector in one column.'],
            ['settings-new-session-wizard-profiles', 'Auto'],
            ['settings-new-session-wizard-backends', 'Auto'],
            ['settings-new-session-wizard-models', 'Dropdown'],
            ['settings-new-session-wizard-machines', 'Auto'],
            ['settings-new-session-wizard-paths', 'Auto'],
            ['settings-new-session-wizard-permissions', 'Auto'],
        ]);

        screen.pressRowByTitle('DropdownItem:Select Machine:Dropdown');
        expect(setPresentation).toHaveBeenCalledWith({
            models: 'dropdown',
            machines: 'dropdown',
        });

        expect(screen.findRowByTitle('Two-column layout')).toBeTruthy();
        screen.pressRowByTitle('Two-column layout');
        expect(setColumnsEnabled).toHaveBeenCalledWith(true);
    });
});
