import { describe, expect, it } from 'vitest';
import { buildKeyboardShortcutSettingsModel } from '@/components/settings/keyboard/keyboardShortcutsSettingsModel';
import { defaultKeyboardCommands } from './commands';
import { BUILT_IN_SETTINGS_METADATA_V1 } from '@happier-dev/protocol/actions/settings/builtInSettingsMetadata';

const isProgramCommand = (id: string) => /^(panes\.|shell\.column\.toggle$|media\.|search\.|files\.editor\.|review\.|editor\.selection\.ask$|files\.track\.toggle$|code\.)/.test(id);

describe('Files and Editor program bindings', () => {
  it('revives the message next/previous ids for the message cursor, honouring overrides saved for them', () => {
    const model = buildKeyboardShortcutSettingsModel({ platform: 'macos', surface: 'native', settings: {
      commandPaletteEnabled: true, keyboardShortcutsV2Enabled: true, keyboardSingleKeyShortcutsEnabled: true,
      keyboardShortcutDisabledCommandIdsV1: ['transcript.message.previous'],
      keyboardShortcutOverridesV1: { 'transcript.message.next': [{ binding: 'j' }] },
    } });
    expect(model.commandRows.find(row => row.commandId === 'transcript.message.next')?.bindingValue).toBe('j');
    expect(model.commandRows.find(row => row.commandId === 'transcript.message.focusLast')?.bindingValue).toBe('Mod+ArrowUp');
    expect(model.commandRows.find(row => row.commandId === 'transcript.scroll.top')?.defaultLabel).toBeTruthy();
    // The cursor's keys live in their own scope: plain arrows, Escape and letters never collide with global commands.
    expect(model.conflicts.filter(conflict => conflict.commandIds.some(id => String(id).startsWith('transcript.message.')))).toEqual([]);
  });
  for (const platform of ['macos', 'windows', 'linux', 'ios', 'android'] as const) {
    for (const surface of ['native', 'web'] as const) {
      it.each([false, true])(`${platform}/${surface} has no program conflicts with single keys %s`, keyboardSingleKeyShortcutsEnabled => {
        const model = buildKeyboardShortcutSettingsModel({ platform, surface, settings: {
          commandPaletteEnabled: true, keyboardShortcutsV2Enabled: true, keyboardSingleKeyShortcutsEnabled,
          keyboardShortcutDisabledCommandIdsV1: [], keyboardShortcutOverridesV1: {},
        } });
        expect(model.conflicts.filter(conflict => conflict.commandIds.some(isProgramCommand))).toEqual([]);
        const format = model.commandRows.find(row => row.commandId === 'code.format');
        const move = model.commandRows.find(row => row.commandId === 'sessions.row.moveToFolder');
        expect(format?.bindingValue).toBe('Alt+Shift+F');
        expect(move?.bindingValue).toBe('Alt+Shift+G');
        expect(model.conflicts.filter(conflict => conflict.commandIds.includes('sessions.row.moveToFolder'))).toEqual([]);
      });
    }
  }
  it('includes pane commands in the audited catalog', () => {
    expect(defaultKeyboardCommands.filter(command => isProgramCommand(command.id)).map(command => command.id)).toContain('panes.main.toggle');
  });
  it('gives every keyboard command one canonical Settings anchor before the page projects its rows', () => {
    expect(defaultKeyboardCommands
      .filter(command => BUILT_IN_SETTINGS_METADATA_V1.filter(setting => setting.anchor === `keyboard.${command.id}`).length !== 1)
      .map(command => command.id)).toEqual([]);
    for (const command of defaultKeyboardCommands) {
      const metadata = BUILT_IN_SETTINGS_METADATA_V1.find(setting => setting.anchor === `keyboard.${command.id}`);
      // A copied sibling id would redirect shortcut edits to a different command.
      expect(metadata && 'storage' in metadata ? metadata.storage : undefined, command.id).toMatchObject({
        scope: 'account', kind: 'owner', owner: 'commandStorage', options: [command.id],
      });
    }
  });
});
