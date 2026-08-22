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
const { PluginSettingMultiSelectField, PluginSettingSelectField } = await import('./PluginSettingChoiceFields');
const { Switch } = await import('@/components/ui/forms/Switch');
const { Item } = await import('@/components/ui/lists/Item');

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

const NULLABLE_SELECT_FIELD: PluginProjectionEditableSettingField = {
    ...SELECT_FIELD,
    valueSchema: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    presentation: {
        options: [
            { value: null, title: 'Inherit', description: 'Follow the workspace choice.' },
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
    // A persisted `null` is a real stored choice: the projection owner already
    // returns it verbatim and only substitutes the declared default for
    // `undefined`. Re-applying the default in the leaf silently showed the user
    // a value they never selected.
    it('renders a persisted null choice instead of re-applying the declared default', async () => {
        const screen = await renderScreen(
            <PluginSettingSelectField
                pluginId="acme.plugin"
                group={GROUP}
                field={NULLABLE_SELECT_FIELD}
                value={null}
                disabled={false}
                onChangeValue={() => {}}
            />,
        );

        const trigger = screen.findAllByType(Pressable).find((node) => (
            typeof node.props['aria-label'] === 'string'
            && node.props['aria-label'].startsWith('Execution mode.')
        )) ?? null;

        expect(trigger).not.toBeNull();
        expect(trigger?.props['aria-label']).toBe('Execution mode. Inherit');
    });

    // An absent value (no persisted setting at all) still resolves to the
    // declared default; only `undefined` may take that path.
    it('falls back to the declared default only when no value is resolved', async () => {
        const screen = await renderScreen(
            <PluginSettingSelectField
                pluginId="acme.plugin"
                group={GROUP}
                field={NULLABLE_SELECT_FIELD}
                value={undefined}
                disabled={false}
                onChangeValue={() => {}}
            />,
        );

        const trigger = screen.findAllByType(Pressable).find((node) => (
            typeof node.props['aria-label'] === 'string'
            && node.props['aria-label'].startsWith('Execution mode.')
        )) ?? null;

        expect(trigger?.props['aria-label']).toBe('Execution mode. Safe');
    });

    // The option description is part of what the choice means. It must reach the
    // accessible name on every platform, not only the web row label that Item
    // happens to synthesize from a rendered subtitle.
    it('carries each option description into the option accessible name', async () => {
        vi.stubGlobal('window', {
            addEventListener() {},
            removeEventListener() {},
            clearTimeout,
            setTimeout,
        });
        const screen = await renderScreen(
            <PluginSettingSelectField
                pluginId="acme.plugin"
                group={GROUP}
                field={SELECT_FIELD}
                value="safe"
                disabled={false}
                onChangeValue={() => {}}
            />,
        );
        const trigger = screen.findAllByType(Pressable).find((node) => (
            node.props['aria-label'] === 'Execution mode. Safe'
        )) ?? null;
        await act(async () => {
            pressTestInstance(trigger, 'enabled plugin setting choice trigger');
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });

        // Assert the EXPLICIT row label, not the web `aria-label`: `Item`
        // synthesizes that one from the visible subtitle, so it would stay green
        // on web while iOS and Android heard only the option title.
        const optionLabels = screen.findAllByType((Item as unknown as { type: unknown }).type)
            .map((node) => node.props.accessibilityLabel)
            .filter((label): label is string => typeof label === 'string');

        expect(optionLabels).toContain('Safe. Use conservative defaults.');
        expect(optionLabels).toContain('Fast. Prioritize speed.');
        // The trigger keeps naming the selected option, not its description.
        const triggerLabels = screen.findAllByType(Pressable)
            .map((node) => node.props['aria-label'])
            .filter((label): label is string => typeof label === 'string');
        expect(triggerLabels).toContain('Execution mode. Safe');
    });
});

describe('PluginSettingMultiSelectField', () => {
    const MULTI_FIELD: PluginProjectionEditableSettingField = {
        ...SELECT_FIELD,
        key: 'modes',
        control: 'multiSelect',
        valueType: 'array',
        valueSchema: { type: 'array', items: { type: 'string' } },
    };

    it('carries each option description into the option and toggle accessible names', async () => {
        const screen = await renderScreen(
            <PluginSettingMultiSelectField
                pluginId="acme.plugin"
                group={GROUP}
                field={MULTI_FIELD}
                value={['safe']}
                disabled={false}
                onChangeValue={() => {}}
            />,
        );

        // The toggle is a separate focusable control from the row, so its own
        // accessible name must carry the description too. Assert the explicit
        // prop rather than the web `aria-label`, which `Item` would synthesize
        // from the visible subtitle even on a platform that never receives it.
        const toggleLabels = screen.findAllByType(Switch)
            .map((node) => node.props.accessibilityLabel)
            .filter((label): label is string => typeof label === 'string');
        expect(toggleLabels).toEqual([
            'Safe. Use conservative defaults.',
            'Fast. Prioritize speed.',
        ]);

        const rowLabels = screen.findAllByType(Pressable)
            .map((node) => node.props['aria-label'])
            .filter((label): label is string => typeof label === 'string');
        expect(rowLabels).toContain('Safe. Use conservative defaults.');
        expect(rowLabels).toContain('Fast. Prioritize speed.');
    });
});
