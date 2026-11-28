import { describe, expect, it } from 'vitest';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { resolveKeyboardCommandSetting } from '@/components/settings/keyboard/keyboardSettings';
import { buildKeyboardShortcutSettingsModel } from '@/components/settings/keyboard/keyboardShortcutsSettingsModel';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';

describe('plugin Action keyboard preferences', () => {
    it('projects admitted palette Action titles into the searchable keyboard settings and retains saved bindings', () => {
        const action = PluginProjectedActionV2Schema.parse({ id: 'run', pluginId: 'acme.tools', occurrenceId: 'tools-running',
            title: 'Run tools', scopes: ['global'], surfaces: ['ui'], placementBindings: ['commandPalette'],
            execution: { target: 'daemon' }, dangerLevel: 'safe', available: true });
        const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, actionsById: { 'acme.tools/run': action } };
        const release = publishCommittedAppShellPluginUiProjection(() => projection);
        try {
            const commandId = 'action:acme.tools/actions/run';
            const setting = resolveKeyboardCommandSetting(commandId);
            expect(setting).toMatchObject({ title: 'Run tools', storage: { kind: 'owner', scope: 'account' } });
            const binding = setting?.storage;
            if (!binding || !('kind' in binding) || binding.kind !== 'owner' || binding.scope !== 'account') throw new Error('Keyboard preference is not writable');
            const settings = accountSettingsParse({});
            const delta = binding.mutate(settings, { enabled: true, binding: 'Mod+Shift+9' });
            expect(delta).toMatchObject({ keyboardShortcutOverridesV1: { [commandId]: [{ binding: 'Mod+Shift+9' }] } });
            const model = buildKeyboardShortcutSettingsModel({ settings: accountSettingsParse({ ...settings, ...delta }),
                platform: 'macos', surface: 'web' });
            expect(model.commandRows.find(row => row.commandId === commandId))
                .toMatchObject({ defaultLabel: 'Cmd+Shift+9', registryDefaultLabel: null, hasOverride: true });
        } finally { release(); }
    });
});
