import { describe, expect, it } from 'vitest';

import {
  resolvePreflightSessionControlsProbeEnvironment,
  withPreflightSessionControlsProbeEnvironment,
} from './preflightSessionControlsProbeEnvironment';

const resolveColdProbeEnvironmentFromUntrustedInput = resolvePreflightSessionControlsProbeEnvironment as unknown as (
  params: Readonly<Record<string, unknown>>,
) => ReturnType<typeof resolvePreflightSessionControlsProbeEnvironment>;

const codexProbeRegistrySnapshot = {
  agentDefinitionsById: new Map([['codex', {
    runtimeSpec: {
      id: 'codex', title: 'Codex', binaryName: 'codex', sourcePreferenceDefault: 'system-first',
      managedInstall: null, manualInstallKind: 'none', manualInstallRecipes: null, acceptsJavaScriptFileOverride: false,
    },
    catalogEntry: {
      id: 'codex', cliSubcommand: 'codex', vendorResumeSupport: 'unsupported',
      connectedAccountNativeHome: { environmentKey: 'CODEX_HOME', defaultRelativePath: '.codex' },
    },
  }]]),
} satisfies NonNullable<Parameters<typeof resolvePreflightSessionControlsProbeEnvironment>[0]['registrySnapshot']>;

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
  it('uses only the selected contributed Agent home and executable declarations', async () => {
    const agentId = 'acme/custom-agent';
    const resolved = await resolvePreflightSessionControlsProbeEnvironment({
      agentId,
      registrySnapshot: {
        agentDefinitionsById: new Map([[agentId, {
          runtimeSpec: {
            id: agentId, title: 'Custom Agent', binaryName: 'custom-agent',
            sourcePreferenceDefault: 'system-first', managedInstall: null,
            manualInstallKind: 'none', manualInstallRecipes: null, acceptsJavaScriptFileOverride: false,
            knownEnvironmentBinDirs: [{ envVar: 'CUSTOM_INSTALL_ROOT', relativeDir: 'bin' }],
            alternativeBinaryFallbackEnabledEnvVar: 'CUSTOM_FALLBACK_ENABLED',
          },
          catalogEntry: {
            id: agentId, cliSubcommand: agentId, vendorResumeSupport: 'unsupported',
            connectedAccountNativeHome: {
              environmentKey: 'CUSTOM_HOME', fallbackEnvironmentKeys: ['CUSTOM_CONFIG_HOME'],
              sourceEnvironmentKey: 'CUSTOM_SOURCE_HOME', defaultRelativePath: '.custom',
            },
          },
        }]]),
      },
      processEnv: {
        PATH: '/usr/bin', CUSTOM_HOME: '/native/custom', CUSTOM_CONFIG_HOME: '/native/config',
        CUSTOM_SOURCE_HOME: '/native/source', CUSTOM_INSTALL_ROOT: '/opt/custom', CUSTOM_FALLBACK_ENABLED: '0',
        HAPPIER_ACME_CUSTOM_AGENT_PATH: '/opt/custom/bin/agent',
        CODEX_HOME: '/unselected/codex', CLAUDE_CONFIG_DIR: '/unselected/claude',
        HAPPIER_CODEX_PATH: '/unselected/codex-bin', HAPPIER_CURSOR_AGENT_FALLBACK_ENABLED: '1',
        CUSTOM_API_KEY: 'fake-ambient-secret', OPENAI_API_KEY: 'fake-unselected-secret',
      },
      materializedEnv: { CUSTOM_HOME: '/selected/materialized', CUSTOM_API_KEY: 'fake-selected-secret' },
    });

    expect(resolved.env).toEqual({
      PATH: '/usr/bin', CUSTOM_HOME: '/selected/materialized', CUSTOM_CONFIG_HOME: '/native/config',
      CUSTOM_SOURCE_HOME: '/native/source', CUSTOM_INSTALL_ROOT: '/opt/custom', CUSTOM_FALLBACK_ENABLED: '0',
      HAPPIER_ACME_CUSTOM_AGENT_PATH: '/opt/custom/bin/agent', CUSTOM_API_KEY: 'fake-selected-secret',
    });
  });

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
      { agentId: 'codex', registrySnapshot: codexProbeRegistrySnapshot, processEnv },
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
          registrySnapshot: codexProbeRegistrySnapshot,
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
