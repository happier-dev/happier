import { describe, expect, it } from 'vitest';

import {
  resolvePreflightSessionControlsProbeEnvironment,
  withPreflightSessionControlsProbeEnvironment,
} from './preflightSessionControlsProbeEnvironment';

const resolveColdProbeEnvironmentFromUntrustedInput = resolvePreflightSessionControlsProbeEnvironment as unknown as (
  params: Readonly<Record<string, unknown>>,
) => ReturnType<typeof resolvePreflightSessionControlsProbeEnvironment>;

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) return await run();

  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

describe('resolvePreflightSessionControlsProbeEnvironment', () => {
  it('passes only approved platform and runtime values to cold probe callbacks', async () => {
    const processEnv = {
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/Users/alice',
      XDG_CONFIG_HOME: '/Users/alice/.config',
      CODEX_HOME: '/Users/alice/.codex',
      HAPPIER_HOME_DIR: '/Users/alice/.happier',
      HAPPIER_CODEX_PATH: '/opt/happier/codex',
      HAPPIER_JS_RUNTIME_PATH: '/opt/happier/node',
      HAPPIER_MANAGED_NODE_BIN: '/opt/happier/managed-node',
      HAPPIER_NODE_PATH: '/opt/happier/node-compat',
      OPENAI_API_KEY: 'ambient-openai-api-key',
      ANTHROPIC_API_KEY: 'ambient-anthropic-api-key',
      CODEX_API_KEY: 'ambient-codex-api-key',
      OPENAI_ACCESS_TOKEN: 'ambient-openai-access-token',
      HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH: '/private/request-auth-capability.json',
      HAPPIER_CLIPROXYAPI_REQUEST_AUTH_CAPABILITY_PATH: '/private/cliproxy-capability.json',
      UNRELATED_SECRET: 'ambient-unrelated-secret',
    } satisfies NodeJS.ProcessEnv;

    const received = await withPreflightSessionControlsProbeEnvironment(
      { agentId: 'codex', processEnv },
      async ({ env }) => env,
    );

    expect(received).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/Users/alice',
      XDG_CONFIG_HOME: '/Users/alice/.config',
      CODEX_HOME: '/Users/alice/.codex',
      HAPPIER_HOME_DIR: '/Users/alice/.happier',
      HAPPIER_CODEX_PATH: '/opt/happier/codex',
      HAPPIER_JS_RUNTIME_PATH: '/opt/happier/node',
      HAPPIER_MANAGED_NODE_BIN: '/opt/happier/managed-node',
      HAPPIER_NODE_PATH: '/opt/happier/node-compat',
    });
  });

  it('adds only an explicit materializer-produced environment after cold-probe sanitization', async () => {
    const received = await withPreflightSessionControlsProbeEnvironment(
      {
        agentId: 'opencode',
        processEnv: {
          PATH: '/usr/bin',
          ANTHROPIC_API_KEY: 'ambient-key-must-be-removed',
        },
        materializedEnv: {
          ANTHROPIC_API_KEY: 'selected-account-key',
          OPENCODE_CONFIG: '/private/materialized/opencode.json',
        },
      },
      async ({ env }) => env,
    );

    expect(received).toEqual({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'selected-account-key',
      OPENCODE_CONFIG: '/private/materialized/opencode.json',
    });
  });

  it('preserves case-insensitive Windows process prerequisites without retaining ambient credentials', async () => {
    await withPlatform('win32', async () => {
      const received = await withPreflightSessionControlsProbeEnvironment(
        {
          agentId: 'codex',
          processEnv: {
            path: 'C:\\Windows\\System32;C:\\tools',
            userprofile: 'C:\\Users\\Alice',
            systemroot: 'C:\\Windows',
            comspec: 'C:\\Windows\\System32\\cmd.exe',
            pathext: '.COM;.EXE;.BAT;.CMD',
            temp: 'C:\\Users\\Alice\\AppData\\Local\\Temp',
            happier_codex_path: 'C:\\tools\\codex.cmd',
            openai_api_key: 'ambient-openai-api-key',
            anthropic_api_key: 'ambient-anthropic-api-key',
          },
        },
        async ({ env }) => env,
      );

      expect(received).toEqual({
        path: 'C:\\Windows\\System32;C:\\tools',
        userprofile: 'C:\\Users\\Alice',
        systemroot: 'C:\\Windows',
        comspec: 'C:\\Windows\\System32\\cmd.exe',
        pathext: '.COM;.EXE;.BAT;.CMD',
        temp: 'C:\\Users\\Alice\\AppData\\Local\\Temp',
        happier_codex_path: 'C:\\tools\\codex.cmd',
      });
    });
  });

  it('does not infer a CLI override key from unrecognized agent text', async () => {
    const resolved = await resolveColdProbeEnvironmentFromUntrustedInput({
      agentId: 'connected-account-request-auth-capability',
      processEnv: {
        PATH: '/usr/local/bin:/usr/bin',
        HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH: '/private/request-auth-capability.json',
      },
    });

    expect(resolved).toEqual({
      env: { PATH: '/usr/local/bin:/usr/bin' },
    });
  });

});
