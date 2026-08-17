import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    PluginProjectionEditableSettingField,
    PluginProjectionEditableSettingsGroup,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { pressTestInstance, renderScreen } from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks();

// The field intentionally exercises the real shared Dropdown/Item path. Load
// that graph once after its boundary mocks are installed so transform work is
// collection time rather than an unrelated per-test timeout.
const { PluginSettingSelectField } = await import('./PluginSettingChoiceFields');

afterEach(() => {
    vi.unstubAllGlobals();
});

const GROUP: PluginProjectionEditableSettingsGroup = {
    id: 'acme.settings',
    pluginId: 'acme.plugin',
    version: 1,
    title: 'Acme settings',
    scope: { kind: 'daemon' },
    presentation: { sections: [], subagentSections: [] },
    target: { kind: 'plugin' },
    fields: [],
};

const SELECT_FIELD: PluginProjectionEditableSettingField = {
    key: 'mode',
    control: 'select',
    secretCustody: null,
    valueType: 'string',
    valueSchema: { type: 'string' },
    title: 'Execution mode',
    subtitle: 'Choose how this plugin runs.',
    redaction: 'none',
    clearWhenEmpty: 'persist',
    defaultValue: 'safe',
    presentation: {
        options: [
            { value: 'safe', title: 'Safe', description: 'Use conservative defaults.' },
            { value: 'fast', title: 'Fast', description: 'Prioritize speed.' },
        ],
    },
};

function findDisabledSelectTrigger(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.findAllByType(Pressable).find((node) => (
        node.props.disabled === true
        && node.props['aria-label'] === 'Execution mode. Safe'
    )) ?? null;
}

describe('PluginSettingSelectField', () => {
    it('keeps a disabled choice trigger semantically disabled and closed', async () => {
        const onChangeValue = () => {};
        const screen = await renderScreen(
            <PluginSettingSelectField
                pluginId="acme.plugin"
                group={GROUP}
                field={SELECT_FIELD}
                value="safe"
                disabled
                onChangeValue={onChangeValue}
            />,
        );

        const trigger = findDisabledSelectTrigger(screen);
        expect(trigger).not.toBeNull();
        expect(trigger?.props.accessibilityState).toMatchObject({ disabled: true, expanded: false });
        expect(trigger?.props['aria-disabled']).toBe(true);
        expect(trigger?.props['aria-expanded']).toBe(false);
        expect(screen.getTextContent()).not.toContain('Fast');

        await act(async () => {
            pressTestInstance(trigger, 'disabled plugin setting choice trigger');
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });

        expect(screen.getTextContent()).not.toContain('Fast');
        expect(findDisabledSelectTrigger(screen)?.props['aria-expanded']).toBe(false);
    });

    it('closes an open choice menu when the field becomes disabled and keeps it closed when re-enabled', async () => {
        vi.stubGlobal('window', {
            addEventListener() {},
            removeEventListener() {},
            clearTimeout,
            setTimeout,
        });
        const renderSelectField = (disabled: boolean) => (
            <PluginSettingSelectField
                pluginId="acme.plugin"
                group={GROUP}
                field={SELECT_FIELD}
                value="safe"
                disabled={disabled}
                onChangeValue={() => {}}
            />
        );
        const screen = await renderScreen(renderSelectField(false));
        const enabledTrigger = screen.findAllByType(Pressable).find((node) => (
            node.props['aria-label'] === 'Execution mode. Safe'
        )) ?? null;

        expect(enabledTrigger).not.toBeNull();
        expect(enabledTrigger?.props.disabled).not.toBe(true);
        await act(async () => {
            pressTestInstance(enabledTrigger, 'enabled plugin setting choice trigger');
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });
        expect(screen.getTextContent()).toContain('Fast');
        expect(screen.findAllByType(Pressable).find((node) => (
            node.props['aria-label'] === 'Execution mode. Safe'
        ))?.props['aria-expanded']).toBe(true);

        await act(async () => {
            screen.tree.update(renderSelectField(true));
        });
        expect(screen.getTextContent()).not.toContain('Fast');
        expect(findDisabledSelectTrigger(screen)?.props['aria-expanded']).toBe(false);

        await act(async () => {
            screen.tree.update(renderSelectField(false));
        });
        expect(screen.getTextContent()).not.toContain('Fast');
        expect(screen.findAllByType(Pressable).find((node) => (
            node.props['aria-label'] === 'Execution mode. Safe'
        ))?.props['aria-expanded']).toBe(false);
    });
});
