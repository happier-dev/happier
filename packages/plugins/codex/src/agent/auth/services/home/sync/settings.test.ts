import { describe, expect, it } from 'vitest';

import {
  codexHomeSyncProviderLabel,
  mapCodexStateSymlinkUnavailableDiagnostic,
  resolveCodexHomeSharingSettings,
} from './settings.js';

describe('Codex home-sync settings policy', () => {
  it('resolves Codex sharing settings from account settings payloads', () => {
    expect(resolveCodexHomeSharingSettings({
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: {
          configMode: 'linked',
          stateMode: 'isolated',
        },
        byAgentId: {
          codex: {
            configMode: 'copied',
            stateMode: 'shared',
          },
        },
      },
    })).toMatchObject({
      configMode: 'copied',
      stateMode: 'shared',
    });
  });

  it('declares the provider label and symlink-unavailable diagnostic shape', () => {
    expect(codexHomeSyncProviderLabel).toBe('Codex');
    expect(mapCodexStateSymlinkUnavailableDiagnostic({
      entryName: 'state_123.sqlite',
      fsCode: 'EPERM',
    })).toEqual({
      code: 'state_symlink_unavailable',
      providerId: 'codex',
      requestedStateMode: 'shared',
      effectiveStateMode: 'isolated',
      entryName: 'state_123.sqlite',
      reason: 'symlink_unavailable',
      fsCode: 'EPERM',
    });
    expect(mapCodexStateSymlinkUnavailableDiagnostic({
      entryName: 'sessions',
      fsCode: null,
    })).toEqual({
      code: 'state_symlink_unavailable',
      providerId: 'codex',
      requestedStateMode: 'shared',
      effectiveStateMode: 'isolated',
      entryName: 'sessions',
      reason: 'symlink_unavailable',
    });
  });
});
