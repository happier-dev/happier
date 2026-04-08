import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

  it('rejects Codex user homePath overrides that do not match the configured home', () => {
    expect(
      validateDirectMachineSource({
        providerId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'user',
          homePath: '/tmp/other-codex-home',
        },
        env: {
          CODEX_HOME: join(homedir(), '.codex'),
        } as NodeJS.ProcessEnv,
      }),
    ).toEqual({ ok: false, error: 'source homePath override is not allowed' });
  });
});
