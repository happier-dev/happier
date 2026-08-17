import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  codexHomeSyncProviderLabel,
  mapCodexStateSymlinkUnavailableDiagnostic,
} from './settings.js';

describe('Codex home-sync settings policy', () => {
  it('does not retain the unreachable raw policy resolver', () => {
    const source = readFileSync(new URL('./settings.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('resolveCodexHomeSharingSettings');
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
