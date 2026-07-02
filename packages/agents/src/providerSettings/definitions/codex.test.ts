import { describe, expect, it } from 'vitest';

import {
  isCodexVendorResumeBackendEnabled,
  resolveCodexRuntimeBackendMode,
  resolveCodexSpawnExtrasFromSettings,
} from '../../runtime/preferences/codex.js';
import { CODEX_PROVIDER_SETTINGS_DEFINITION } from './codex.js';

describe('resolveCodexRuntimeBackendMode', () => {
  it('prefers explicit canonical backend modes over the fallback mode', () => {
    expect(resolveCodexRuntimeBackendMode({
      codexBackendMode: 'appServer',
      defaultBackendMode: 'mcp',
    })).toBe('appServer');
  });

  it('uses the provided fallback backend mode when no canonical mode is set', () => {
    expect(resolveCodexRuntimeBackendMode({ defaultBackendMode: 'mcp' })).toBe('appServer');
    expect(resolveCodexRuntimeBackendMode({ defaultBackendMode: 'acp' })).toBe('acp');
  });
});

describe('resolveCodexSpawnExtrasFromSettings', () => {
  it('keeps ACP on the canonical backend mode path without re-emitting the legacy flag', () => {
    expect(resolveCodexSpawnExtrasFromSettings({ codexBackendMode: 'acp' })).toEqual({
      codexBackendMode: 'acp',
    });
  });

  it('does not emit the legacy ACP flag for canonical non-ACP backend modes', () => {
    expect(resolveCodexSpawnExtrasFromSettings({ codexBackendMode: 'mcp' })).toEqual({
      codexBackendMode: 'appServer',
    });
    expect(resolveCodexSpawnExtrasFromSettings({ codexBackendMode: 'appServer' })).toEqual({
      codexBackendMode: 'appServer',
    });
  });

  it('maps the legacy mcp_resume setting onto canonical ACP extras even when persisted with whitespace', () => {
    expect(resolveCodexSpawnExtrasFromSettings({ codexBackendMode: '  mcp_resume  ' })).toEqual({
      codexBackendMode: 'acp',
    });
  });

  it('maps the legacy experimentalCodexAcp setting onto canonical ACP extras at the settings ingress only', () => {
    expect(resolveCodexSpawnExtrasFromSettings({ experimentalCodexAcp: true })).toEqual({
      codexBackendMode: 'acp',
    });
  });

  it('returns no spawn extras when no canonical backend mode is configured', () => {
    expect(resolveCodexSpawnExtrasFromSettings({})).toEqual({});
  });
});

describe('CODEX_PROVIDER_SETTINGS_DEFINITION', () => {
  it('stays descriptor-only and does not carry runtime preference behavior', () => {
    expect(CODEX_PROVIDER_SETTINGS_DEFINITION).toMatchObject({
      providerId: 'codex',
      fields: expect.any(Object),
    });
    expect('resolveSpawnExtras' in CODEX_PROVIDER_SETTINGS_DEFINITION).toBe(false);
    expect('buildOutgoingMessageMetaExtras' in CODEX_PROVIDER_SETTINGS_DEFINITION).toBe(false);
  });
});

describe('isCodexVendorResumeBackendEnabled', () => {
  it('checks vendor resume support from the canonical backend mode path', () => {
    expect(isCodexVendorResumeBackendEnabled({ codexBackendMode: 'appServer' })).toBe(true);
    expect(isCodexVendorResumeBackendEnabled({ codexBackendMode: 'acp' })).toBe(true);
    expect(isCodexVendorResumeBackendEnabled({ codexBackendMode: 'mcp' })).toBe(true);
  });

  it('keeps the legacy acp compatibility fallback at settings ingress only', () => {
    expect(isCodexVendorResumeBackendEnabled({ experimentalCodexAcp: true })).toBe(true);
    expect(isCodexVendorResumeBackendEnabled({ experimentalCodexAcp: false })).toBe(false);
  });
});
