import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { PI_DIRECT_AUTH_ENV_KEYS, PI_LAUNCH_ENV_KEYS } from './agent/launchEnvironment.js';
import {
  PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
} from './agent/auth/services/requestAuth/purposes.js';
import { PI_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';

export {
  PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
};

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.agent.pi',
  version: '0.0.0',
  displayName: 'Pi',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'pi-workspace',
      capability: 'filesystem',
      reason: 'Use the admitted Agent workspace as the Pi process working directory.',
      scope: {
        locations: [{ root: 'workspace' }],
        access: ['read'],
      },
    }, {
      id: 'pi-process',
      capability: 'process',
      reason: 'Launch the Pi coding-agent CLI through the host execution service.',
      scope: {
        executables: [{ kind: 'systemTool', id: 'pi-cli' }],
        envKeys: [...PI_LAUNCH_ENV_KEYS],
      },
    }],
    optional: [],
  },
  contributes: {
    agents: [{
      id: 'pi',
      title: 'Pi',
      runtime: { kind: 'custom' },
      cli: {
        displayName: 'Pi Coding Agent CLI',
        executable: {
          binaryName: 'pi',
          knownUserBinDirSuffixes: null,
          sourcePreference: 'system-first',
        },
        install: {
          managed: {
            kind: 'managed_package',
            packageName: '@earendil-works/pi-coding-agent',
            binaryName: 'pi',
          },
          manual: { kind: 'command' },
          guideUrl: 'https://github.com/badlogic/pi-mono',
          docsUrl: null,
        },
        auth: {
          support: 'status_only',
          probe: {
            parser: 'piEnvOnly',
            backgroundChecks: 'safe',
            statusArgs: null,
            envVars: [...PI_DIRECT_AUTH_ENV_KEYS],
          },
          loginLaunches: [],
        },
      },
      primary: 'sessions',
      connectedAccounts: [{
        purpose: PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
        service: {
          pluginId: 'happier.agent.claude',
          localId: 'claude-subscription',
        },
      }, {
        purpose: PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
        service: {
          pluginId: 'happier.agent.codex',
          localId: 'openai-codex',
        },
      }],
      capabilities: {
        surfaces: ['externalSessions'],
        sessions: {
          open: ['create', 'resume'],
          delivery: ['newTurn', 'steer', 'followUp'],
          cancel: true,
          configuration: true,
          compaction: { events: true, manual: true },
          usageLimitRecovery: { active: ['checkNow'], inactive: ['checkNow'] },
        },
        executionRuns: { open: ['create'], checkpoint: false, stop: true },
      },
      surfaces: {
        externalSession: {
          externalLinkedTakeover: { writerSafety: 'unsupported' },
          sources: [{
            sourceKind: 'piAgentDir',
            schema: {
              fields: [
                { kind: 'literal', name: 'kind', value: 'piAgentDir' },
                { kind: 'string', name: 'agentDir', min: 1, max: 10_000, nullish: true },
              ],
              passthrough: true,
            },
            key: {
              segments: [
                { kind: 'literal', value: 'piAgentDir' },
                { kind: 'field', field: 'agentDir' },
              ],
            },
            instances: [{ kind: 'default', constants: {} }],
          }],
        },
      },
    }],
    systemTools: [{ id: 'pi-cli', title: 'Pi coding-agent CLI', executableNames: ['pi'] }],
    settings: [PI_AGENT_SETTINGS_CONTRIBUTION],
  },
} satisfies PluginManifest;
