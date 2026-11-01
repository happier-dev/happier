import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  buildCodexProviderSettingsShape,
  CODEX_PROVIDER_SETTINGS_DEFINITION,
  CODEX_PROVIDER_SETTINGS_DEFAULTS,
  isCodexVendorResumeBackendEnabled,
  resolveCodexRuntimeBackendMode,
  resolveCodexSpawnExtrasFromSettings,
} from './codex.js';

describe('Codex reasoning summary settings', () => {
  it('preserves native defaults for old settings and accepts independent explicit generation choices', () => {
    const schema = z.object(buildCodexProviderSettingsShape(z));
    expect(schema.parse(CODEX_PROVIDER_SETTINGS_DEFAULTS)).toMatchObject({ codexReasoningSummaries: 'default' });
    expect(CODEX_PROVIDER_SETTINGS_DEFINITION.fields.codexReasoningSummaries?.storageScope).toBe('account');
    for (const preference of ['default', 'enabled', 'disabled']) {
      expect(schema.parse({ ...CODEX_PROVIDER_SETTINGS_DEFAULTS, codexReasoningSummaries: preference })).toMatchObject({ codexReasoningSummaries: preference });
    }
    expect(schema.parse({ ...CODEX_PROVIDER_SETTINGS_DEFAULTS, codexReasoningSummaries: 'invalid' })).toMatchObject({ codexReasoningSummaries: 'default' });
  });
});

describe('resolveCodexRuntimeBackendMode', () => {
  it('prefers explicit canonical backend modes over the legacy ACP flag and fallback mode', () => {
    expect(resolveCodexRuntimeBackendMode({
      codexBackendMode: 'appServer',
      experimentalCodexAcp: true,
      defaultBackendMode: 'mcp',
    })).toBe('appServer');
  });

  it('falls back to the legacy ACP flag only when neither canonical mode nor a default mode is present', () => {
    expect(resolveCodexRuntimeBackendMode({
      experimentalCodexAcp: true,
    })).toBe('acp');
    expect(resolveCodexRuntimeBackendMode({
      experimentalCodexAcp: true,
      defaultBackendMode: 'mcp',
    })).toBe('mcp');
  });

  it('uses the provided fallback backend mode when neither canonical mode nor legacy flag is set', () => {
    expect(resolveCodexRuntimeBackendMode({ defaultBackendMode: 'mcp' })).toBe('mcp');
    expect(resolveCodexRuntimeBackendMode({ defaultBackendMode: 'acp' })).toBe('acp');
  });
});

describe('resolveCodexSpawnExtrasFromSettings', () => {
  it('keeps ACP on the canonical backend mode path and exposes the legacy flag only as compatibility fallback', () => {
    expect(resolveCodexSpawnExtrasFromSettings({ codexBackendMode: 'acp' })).toEqual({
      codexBackendMode: 'acp',
      experimentalCodexAcp: true,
    });
  });

  it('does not emit the legacy ACP flag for canonical non-ACP backend modes', () => {
    expect(resolveCodexSpawnExtrasFromSettings({ codexBackendMode: 'mcp' })).toEqual({
      codexBackendMode: 'mcp',
    });
    expect(resolveCodexSpawnExtrasFromSettings({ codexBackendMode: 'appServer' })).toEqual({
      codexBackendMode: 'appServer',
    });
  });

  it('maps the legacy mcp_resume setting onto canonical ACP extras even when persisted with whitespace', () => {
    expect(resolveCodexSpawnExtrasFromSettings({ codexBackendMode: '  mcp_resume  ' })).toEqual({
      codexBackendMode: 'acp',
      experimentalCodexAcp: true,
    });
  });

  it('returns no spawn extras when no canonical backend mode is configured', () => {
    expect(resolveCodexSpawnExtrasFromSettings({})).toEqual({});
  });
});

describe('isCodexVendorResumeBackendEnabled', () => {
  it('checks vendor resume support from the canonical backend mode path', () => {
    expect(isCodexVendorResumeBackendEnabled({ codexBackendMode: 'appServer' })).toBe(true);
    expect(isCodexVendorResumeBackendEnabled({ codexBackendMode: 'acp' })).toBe(true);
    expect(isCodexVendorResumeBackendEnabled({ codexBackendMode: 'mcp' })).toBe(false);
  });

  it('keeps the legacy acp compatibility fallback for callers without codexBackendMode', () => {
    expect(isCodexVendorResumeBackendEnabled({ experimentalCodexAcp: true })).toBe(true);
    expect(isCodexVendorResumeBackendEnabled({ experimentalCodexAcp: false })).toBe(false);
  });
});
