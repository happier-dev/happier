import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';
import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const popoverBoundaryRef = { current: { nodeType: 'AutomationBoundary' } } as React.RefObject<any>;

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: createPassThroughComponent('View'),
            Platform: {
                OS: 'ios',
                select: <T,>(values: { ios?: T; default?: T }) => values.ios ?? values.default,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    groupped: { background: '#f5f5f5', sectionTitle: '#666' },
                    input: { background: '#fff', placeholder: '#888' },
                    surface: '#ffffff',
                    divider: '#ddd',
                    text: '#111',
                    textSecondary: '#666',
                },
            },
        });
    },
    icons: () => ({
        Ionicons: createPassThroughComponent('Ionicons'),
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key, params) => params ? key : key });
    },
});

vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/Item', () => createPassThroughModule(['Item']));
vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemList']));
vi.mock('@/components/ui/lists/ItemGroupColumns', () => createPassThroughModule(['ItemGroupColumns', 'ItemGroupColumn']));
vi.mock('@/components/ui/forms/FieldItem', () => createPassThroughModule(['FieldItem']));
vi.mock('@/components/ui/forms/Switch', () => createPassThroughModule(['Switch']));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => createPassThroughModule(['DropdownMenu']));
vi.mock('@/components/ui/popover', () => ({
    usePopoverBoundaryRef: () => popoverBoundaryRef,
}));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text', 'TextInput']));

describe('AutomationSettingsPopoverContent', () => {
    it('keeps the enable toggle header and replaces the form body with sentence controls', async () => {
        const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
        const screen = await renderScreen(<AutomationSettingsPopoverContent
            value={{
                enabled: true,
                name: 'Nightly',
                description: 'Run nightly work',
                scheduleKind: 'interval',
                everyMinutes: 30,
                cronExpr: '0 * * * *',
                timezone: 'UTC',
            }}
            onChange={() => {}}
        />);

        const enableItem = screen.findByType('Item' as any);
        const toggle = enableItem.props.rightElement;
        expect(toggle?.props?.value).toBe(true);

        expect(screen.findAllByType('AutomationSettingsForm' as any)).toHaveLength(0);
        expect(screen.findByProps({ testID: 'automation-sentence-name-input' }).props.value).toBe('Nightly');
        expect(screen.findByProps({ testID: 'automation-sentence-schedule-trigger' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-sentence-notes-input' }).props.value).toBe('Run nightly work');
    });

    it('keeps details collapsed when disabled', async () => {
        const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
        const screen = await renderScreen(<AutomationSettingsPopoverContent
            value={{
                enabled: false,
                name: '',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            }}
            onChange={() => {}}
        />);

        expect(screen.findByType('Item' as any).props.rightElement?.props?.value).toBe(false);
        expect(screen.findAllByProps({ testID: 'automation-sentence-name-input' })).toHaveLength(0);
        expect(screen.findAllByProps({ testID: 'automation-sentence-schedule-trigger' })).toHaveLength(0);
    });

    it('lets users choose hour presets, enter day intervals, and switch to cron from the sentence schedule editor', async () => {
        const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
        const onChange = vi.fn();
        const screen = await renderScreen(<AutomationSettingsPopoverContent
            value={{
                enabled: true,
                name: '',
                description: '',
                scheduleKind: 'interval',
                everyMinutes: 60,
                cronExpr: '0 * * * *',
                timezone: null,
            }}
            onChange={onChange}
        />);

        await act(async () => {
            screen.findByProps({ testID: 'automation-sentence-schedule-trigger' }).props.onPress();
        });
        screen.findByProps({ testID: 'automation-schedule-preset-120' }).props.onPress();
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            scheduleKind: 'interval',
            everyMinutes: 120,
        }));

        const unitDropdown = screen.findByType('DropdownMenu' as any);
        expect(unitDropdown.props).toEqual(expect.objectContaining({
            popoverBoundaryRef,
            connectToTrigger: true,
        }));
        expect('popoverPortalWebTarget' in unitDropdown.props).toBe(false);

        unitDropdown.props.onSelect('days');
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            scheduleKind: 'interval',
            everyMinutes: 24 * 60,
        }));

        screen.findByProps({ testID: 'automation-schedule-use-cron' }).props.onPress();
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
            scheduleKind: 'cron',
        }));
    });

    it('shows a compact cron field guide inside the cron editor', async () => {
        const { AutomationSettingsPopoverContent } = await import('./AutomationSettingsPopoverContent');
        const screen = await renderScreen(<AutomationSettingsPopoverContent
            value={{
                enabled: true,
                name: '',
                description: '',
                scheduleKind: 'cron',
                everyMinutes: 60,
                cronExpr: '0 9 * * 1-5',
                timezone: null,
            }}
            onChange={() => {}}
        />);

        await act(async () => {
            screen.findByProps({ testID: 'automation-sentence-schedule-trigger' }).props.onPress();
        });

        expect(screen.findByProps({ testID: 'automation-cron-field-guide' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-cron-field-guide-item-minute' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-cron-field-guide-item-hour' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-cron-field-guide-item-dayOfMonth' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-cron-field-guide-item-month' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'automation-cron-field-guide-item-weekday' })).toBeTruthy();
    });
});
