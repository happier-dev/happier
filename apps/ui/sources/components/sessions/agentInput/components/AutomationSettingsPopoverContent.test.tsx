import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: createPassThroughComponent('View'),
                            Platform: {
                                OS: 'ios',
                                select: <T,>(values: { ios?: T; default?: T }) => values.ios ?? values.default,
                            },
                        }
    );
});

vi.mock('react-native-unistyles', async () => await createUnistylesMock({
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
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: createPassThroughComponent('Ionicons'),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));
vi.mock('@/components/ui/lists/Item', () => createPassThroughModule(['Item']));
vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemList']));
vi.mock('@/components/ui/lists/ItemGroupColumns', () => createPassThroughModule(['ItemGroupColumns', 'ItemGroupColumn']));
vi.mock('@/components/ui/forms/FieldItem', () => createPassThroughModule(['FieldItem']));
vi.mock('@/components/ui/forms/Switch', () => createPassThroughModule(['Switch']));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => createPassThroughModule(['DropdownMenu']));
vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text', 'TextInput']));

vi.mock('@/text', () => createTextModuleMock());

describe('AutomationSettingsPopoverContent', () => {
    it('renders an enable toggle header and renders details only when automation is enabled', async () => {
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

        const form = screen.findByProps({ variant: 'new-session', showEnabledToggle: false });
        expect(form.props.value).toMatchObject({
            enabled: true,
            name: 'Nightly',
            description: 'Run nightly work',
            scheduleKind: 'interval',
            everyMinutes: 30,
            cronExpr: '0 * * * *',
            timezone: 'UTC',
        });
    });
});
