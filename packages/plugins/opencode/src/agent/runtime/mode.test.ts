import { describe, expect, it } from 'vitest';

import { resolveOpenCodeBackendMode } from './mode.js';

describe('resolveOpenCodeBackendMode for execution runs', () => {
  it('defaults OpenCode execution runs to server mode', () => {
    expect(resolveOpenCodeBackendMode({ env: undefined })).toBe('server');
  });

  it('lets execution-run isolation env prefer ACP over account settings', () => {
    expect(resolveOpenCodeBackendMode({
      env: { HAPPIER_OPENCODE_BACKEND_MODE: ' acp ' },
      accountSettings: {
        opencodeBackendMode: 'server',
      },
    })).toBe('acp');
  });

  it('uses account settings when no explicit env override is present', () => {
    expect(resolveOpenCodeBackendMode({
      env: {},
      accountSettings: {
        opencodeBackendMode: 'acp',
      },
    })).toBe('acp');
  });
});
