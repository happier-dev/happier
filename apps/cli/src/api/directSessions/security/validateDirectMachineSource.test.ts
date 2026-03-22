import { describe, expect, it } from 'vitest';

import { validateDirectMachineSource } from './validateDirectMachineSource';

describe('validateDirectMachineSource', () => {
  it('rejects Codex connectedService source ids with path traversal segments', () => {
    expect(
      validateDirectMachineSource({
        providerId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: '../escape',
        },
        env: {},
      }),
    ).toEqual({ ok: false, error: 'invalid connectedServiceId' });
  });

  it('accepts safe Codex connectedService source ids', () => {
    expect(
      validateDirectMachineSource({
        providerId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
        },
        env: {},
      }),
    ).toEqual({
      ok: true,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
      },
    });
  });
});
