import { describe, expect, it } from 'vitest';
import { accountSettingsParse, buildBackendTargetKey } from '@happier-dev/protocol';

import { assertBackendEnabledByAccountSettings } from './backendEnabled';

describe('assertBackendEnabledByAccountSettings', () => {
  it('does not throw when the backendEnabledByTargetKey map is missing', () => {
    expect(() => assertBackendEnabledByAccountSettings({
      agentId: 'codex' as any,
      settings: {},
    })).not.toThrow();
  });

  it('does not throw when the backend is enabled', () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' });
    expect(() => assertBackendEnabledByAccountSettings({
      agentId: 'codex' as any,
      settings: { backendEnabledByTargetKey: { [targetKey]: true } },
    })).not.toThrow();
  });

  it('throws when the backend is disabled in the canonical parsed projection', () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' });
    // Every production caller passes the PARSED Account Settings, whose catalog
    // rewrites this legacy key to its canonical V2 spelling. Asserting against a
    // record keyed by the builder this module used to call could not fail when
    // the two vocabularies diverged.
    const settings = accountSettingsParse({ backendEnabledByTargetKey: { [targetKey]: false } });
    expect(Object.keys(settings.backendEnabledByTargetKey)).not.toContain(targetKey);
    expect(() => assertBackendEnabledByAccountSettings({
      agentId: 'codex' as any,
      settings: settings as unknown as Record<string, unknown>,
    })).toThrow(/disabled/i);
  });

  it('throws when a configured ACP backend target is disabled in the canonical parsed projection', () => {
    const targetKey = buildBackendTargetKey({ kind: 'configuredAcpBackend', backendId: 'review-bot' });
    const settings = accountSettingsParse({ backendEnabledByTargetKey: { [targetKey]: false } });
    expect(Object.keys(settings.backendEnabledByTargetKey)).not.toContain(targetKey);
    expect(() => assertBackendEnabledByAccountSettings({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      settings: settings as unknown as Record<string, unknown>,
    })).toThrow(/review-bot/i);
  });

  it('still honors a legacy-keyed document that has not been parsed yet', () => {
    const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' });
    expect(() => assertBackendEnabledByAccountSettings({
      agentId: 'codex' as any,
      settings: { backendEnabledByTargetKey: { [targetKey]: false } },
    })).toThrow(/disabled/i);
  });
});
