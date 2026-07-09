import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { validateDirectMachineSource } from './validateDirectMachineSource';

describe('validateDirectMachineSource', () => {
  it('rejects Codex connectedService source ids with path traversal segments', async () => {
    await expect(
      validateDirectMachineSource({
        providerId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: '../escape',
        },
        env: {},
      }),
    ).resolves.toEqual({ ok: false, error: 'invalid connectedServiceId' });
  });

  it('accepts safe Codex connectedService source ids', async () => {
    await expect(
      validateDirectMachineSource({
        providerId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
        },
        env: {},
      }),
    ).resolves.toEqual({
      ok: true,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
      },
    });
  });

  it('fills the configured Codex home path when the user source omits it', async () => {
    await expect(
      validateDirectMachineSource({
        providerId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'user',
        },
        env: {
          CODEX_HOME: '/tmp/codex-home',
        } as NodeJS.ProcessEnv,
      }),
    ).resolves.toEqual({
      ok: true,
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/tmp/codex-home',
      },
    });
  });

  it('rejects Codex user homePath overrides that do not match the configured home', async () => {
    await expect(
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
    ).resolves.toEqual({ ok: false, error: 'source homePath override is not allowed' });
  });

  it('fills the configured ohMyPi agent dir when the source omits it', async () => {
    await expect(
      validateDirectMachineSource({
        providerId: 'ohMyPi',
        source: {
          kind: 'ohMyPiAgentDir',
        },
        env: {
          PI_CODING_AGENT_DIR: '/tmp/omp-agent',
        } as NodeJS.ProcessEnv,
      }),
    ).resolves.toEqual({
      ok: true,
      source: {
        kind: 'ohMyPiAgentDir',
        agentDir: '/tmp/omp-agent',
      },
    });
  });

  it('rejects ohMyPi agentDir overrides that do not match the configured agent dir', async () => {
    await expect(
      validateDirectMachineSource({
        providerId: 'ohMyPi',
        source: {
          kind: 'ohMyPiAgentDir',
          agentDir: '/tmp/other-omp-agent',
        },
        env: {
          PI_CODING_AGENT_DIR: '/tmp/omp-agent',
        } as NodeJS.ProcessEnv,
      }),
    ).resolves.toEqual({ ok: false, error: 'source agentDir override is not allowed' });
  });

  it('rejects malformed OpenCode baseUrl values instead of throwing', async () => {
    await expect(
      validateDirectMachineSource({
        providerId: 'opencode',
        source: {
          kind: 'opencodeServer',
          baseUrl: 'not a url',
        },
        env: {} as NodeJS.ProcessEnv,
      }),
    ).resolves.toEqual({ ok: false, error: 'invalid source baseUrl' });
  });
});
