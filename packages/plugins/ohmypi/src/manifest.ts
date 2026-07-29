import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { OH_MY_PI_SYSTEM_TOOL_ID } from './agent/systemTool.js';

const OH_MY_PI_AUTH_ENV_KEYS = [
  'OPENAI_CODEX_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
] as const;

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.agent.ohmypi',
  version: '0.0.0',
  displayName: 'Oh My Pi',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'ohmypi-process',
      capability: 'process',
      reason: 'Launch the user-installed Oh My Pi CLI through the host execution service.',
      scope: {
        executables: [{ kind: 'systemTool', id: OH_MY_PI_SYSTEM_TOOL_ID }],
        envKeys: [...OH_MY_PI_AUTH_ENV_KEYS, 'PI_CODING_AGENT_DIR'],
      },
    }],
    optional: [],
  },
  contributes: {
    agents: [{
      id: 'ohmypi',
      title: 'Oh My Pi',
      runtime: { kind: 'custom' },
      cli: {
        displayName: 'oh-my-pi CLI',
        executable: {
          binaryName: 'omp',
          knownUserBinDirSuffixes: ['.bun/bin'],
          sourcePreference: 'system-first',
          acceptsJavaScriptFileOverride: true,
        },
        install: {
          managed: {
            kind: 'github_release_binary',
            githubRepo: 'can1357/oh-my-pi',
            binaryName: 'omp',
          },
          manual: {
            kind: 'vendor_recipe',
            recipes: {
              darwin: [{ cmd: 'bun', args: ['install', '-g', '@oh-my-pi/pi-coding-agent'] }],
              linux: [{ cmd: 'bun', args: ['install', '-g', '@oh-my-pi/pi-coding-agent'] }],
              win32: [{ cmd: 'bun', args: ['install', '-g', '@oh-my-pi/pi-coding-agent'] }],
            },
          },
          guideUrl: 'https://github.com/can1357/oh-my-pi#via-bun-recommended',
          docsUrl: 'https://github.com/can1357/oh-my-pi',
        },
        auth: {
          support: 'manual_only',
          machineLoginKey: 'oh-my-pi',
          probe: {
            parser: 'piEnvOnly',
            backgroundChecks: 'safe',
            statusArgs: null,
            envVars: [...OH_MY_PI_AUTH_ENV_KEYS],
          },
          loginLaunches: [],
        },
      },
      primary: 'sessions',
      capabilities: {
        surfaces: ['externalSessions'],
        sessions: {
          open: ['create', 'resume', 'fork'],
          delivery: ['newTurn'],
          cancel: true,
          configuration: true,
        },
      },
      surfaces: {
        externalSession: {
          externalLinkedTakeover: { writerSafety: 'unsupported' },
          sources: [{
            sourceKind: 'ohMyPiAgentDir',
            schema: {
              fields: [
                { kind: 'literal', name: 'kind', value: 'ohMyPiAgentDir' },
                { kind: 'string', name: 'agentDir', min: 1, max: 10_000, nullish: true },
              ],
              passthrough: true,
            },
            key: {
              segments: [
                { kind: 'literal', value: 'ohMyPiAgentDir' },
                { kind: 'field', field: 'agentDir' },
              ],
            },
            instances: [{ kind: 'default', constants: {} }],
          }],
        },
      },
    }],
    systemTools: [{ id: OH_MY_PI_SYSTEM_TOOL_ID, title: 'Oh My Pi CLI', executableNames: ['omp'] }],
    hooks: [{
      id: 'resolve-prerequisites',
      on: 'agent.resolvePrerequisites',
      hookApiVersion: 1,
      category: 'decision',
      scope: 'agent',
      filters: { agentId: 'ohMyPi' },
      executionKind: 'decide',
    }],
  },
} satisfies PluginManifest;
