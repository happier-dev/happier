import { describe, expect, it } from 'vitest';

import {
  readVoiceDiagnosticsSettings,
  voiceSettingsParse,
  writeVoiceDiagnosticsSettings,
} from './voiceSettings';

describe('voice diagnostics account settings', () => {
  it('defaults off and requires explicit consent plus at least one capture direction', () => {
    const settings = voiceSettingsParse({});
    expect(readVoiceDiagnosticsSettings(settings)).toMatchObject({
      v: 1,
      enabled: false,
      consentVersion: null,
      captureSttInput: false,
      captureTtsOutput: false,
    });
    expect(() => writeVoiceDiagnosticsSettings(settings, {
      ...readVoiceDiagnosticsSettings(settings), enabled: true, consentVersion: 1,
    })).toThrow();
  });

  it('roundtrips the bounded canonical envelope without a parallel debug setting', () => {
    const settings = voiceSettingsParse({});
    const next = writeVoiceDiagnosticsSettings(settings, {
      ...readVoiceDiagnosticsSettings(settings),
      enabled: true,
      consentVersion: 1,
      captureSttInput: true,
      maxFiles: 5,
    });
    expect(readVoiceDiagnosticsSettings(voiceSettingsParse(JSON.parse(JSON.stringify(next))))).toMatchObject({
      enabled: true,
      consentVersion: 1,
      captureSttInput: true,
      captureTtsOutput: false,
      maxFiles: 5,
    });
  });
});
