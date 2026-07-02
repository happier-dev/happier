import { describe, expect, it } from 'vitest';

import {
  KIMI_PROVIDER_SETTINGS_DEFAULTS,
  normalizeKimiAcpPythonSelector,
  resolveKimiSpawnExtrasFromSettings,
} from './kimi.js';

describe('Kimi provider settings', () => {
  it('defaults the ACP Python selector to automatic mode', () => {
    expect(KIMI_PROVIDER_SETTINGS_DEFAULTS).toEqual({
      kimiAcpPythonSelector: 'auto',
    });
  });

  it('normalizes supported ACP Python selector values', () => {
    expect(normalizeKimiAcpPythonSelector(' poll ')).toBe('poll');
    expect(normalizeKimiAcpPythonSelector('AUTO')).toBe('auto');
    expect(normalizeKimiAcpPythonSelector('epoll')).toBeNull();
    expect(normalizeKimiAcpPythonSelector(true)).toBeNull();
  });

  it('resolves only non-default selector settings into spawn extras', () => {
    expect(resolveKimiSpawnExtrasFromSettings({ kimiAcpPythonSelector: 'poll' })).toEqual({
      kimiAcpPythonSelector: 'poll',
    });
    expect(resolveKimiSpawnExtrasFromSettings({ kimiAcpPythonSelector: 'auto' })).toEqual({});
    expect(resolveKimiSpawnExtrasFromSettings({ kimiAcpPythonSelector: 'invalid' })).toEqual({});
  });
});
