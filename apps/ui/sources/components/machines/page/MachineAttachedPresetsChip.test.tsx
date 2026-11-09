import { describe, expect, it } from 'vitest';

import { machineSetupSourceName } from '@/components/machines/setup/machineSetupSourceName';
import { t } from '@/text';

import { machineAttachedPresetsLabel } from './MachineAttachedPresetsChip';

describe('machine attached presets chip label', () => {
  it('names two presets from the current catalog and counts the rest', () => {
    const presets = [{ id: 'web', name: 'Production web server' }];
    const names = [
      machineSetupSourceName({ kind: 'accountPreset', presetId: 'web' }, presets),
      machineSetupSourceName({ kind: 'bundledPreset', ref: { pluginId: 'example.setup', localId: 'secure', revision: '1' } }, presets),
      machineSetupSourceName({ kind: 'accountPreset', presetId: 'gone' }, presets),
    ];
    expect(machineAttachedPresetsLabel(names)).toBe(`Production web server \u00b7 ${t('machinePresets.setup.tab.bundledPreset')} +1`);
    expect(machineAttachedPresetsLabel(names.slice(0, 2))).not.toContain('+');
  });
});
