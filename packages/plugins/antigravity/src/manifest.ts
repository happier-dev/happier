import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';

import { ANTIGRAVITY_CLI_SYSTEM_TOOL_ID } from './agent/systemTool.js';
import { ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION } from './agentSettings/definition.js';
import {
  ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_KEY,
} from './agent/localharness/installable.js';

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: 'happier.agent.antigravity',
  version: '0.0.0',
  displayName: 'Antigravity',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [{
      id: 'antigravity-external-session-transcripts',
      capability: 'filesystem',
      reason: 'Read source-qualified Antigravity CLI transcripts for External Session observation.',
      scope: {
        locations: [{ root: 'workspace' }],
        access: ['read'],
      },
    }, {
      id: 'localharness-process',
      capability: 'process',
      reason: 'Launch the managed Antigravity localharness through host-mediated execution.',
      scope: { executables: [{ kind: 'managedDependency', id: 'localharness' }] },
    }, {
      id: 'antigravity-cli-process',
      capability: 'process',
      reason: 'Launch the user-installed Antigravity CLI through host-mediated execution.',
      scope: { executables: [{ kind: 'systemTool', id: ANTIGRAVITY_CLI_SYSTEM_TOOL_ID }] },
    }],
    optional: [],
  },
  contributes: {
    agents: [{
      id: 'antigravity',
      title: 'Antigravity',
      runtime: { kind: 'custom' },
      cli: {
        displayName: 'Antigravity CLI',
        executable: {
          binaryName: 'agy',
          knownUserBinDirSuffixes: null,
          sourcePreference: 'system-first',
        },
        install: {
          managed: null,
          manual: {
            kind: 'vendor_recipe',
            recipes: {
              darwin: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'] }],
              linux: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'] }],
              win32: [{
                cmd: 'powershell',
                args: [
                  '-NoProfile',
                  '-ExecutionPolicy',
                  'Bypass',
                  '-Command',
                  'irm https://antigravity.google/cli/install.ps1 | iex',
                ],
              }],
            },
          },
          guideUrl: 'https://antigravity.google/docs/cli-install',
          docsUrl: 'https://antigravity.google/docs/cli-install',
        },
        auth: {
          support: 'login_terminal',
          machineLoginKey: 'antigravity-cli',
          probe: { parser: 'none', backgroundChecks: 'manual_only', statusArgs: null },
          loginLaunches: [{ kind: 'primary', args: [] }],
        },
      },
      primary: 'sessions',
      connectedAccounts: [{
        purpose: 'model_upstream',
        service: {
          pluginId: 'happier.agent.gemini',
          localId: 'gemini-account',
        },
        required: false,
        materializationKinds: ['environment'],
      }],
      capabilities: {
        surfaces: ['terminal', 'externalSessions'],
        sessions: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true },
        executionRuns: { open: ['create'], checkpoint: false, stop: true },
      },
      surfaces: {
        externalSession: {
          externalLinkedTakeover: { writerSafety: 'unsupported' },
          sources: [{
            sourceKind: 'antigravityCliPrint',
            schema: {
              fields: [
                { kind: 'literal', name: 'kind', value: 'antigravityCliPrint' },
                { kind: 'string', name: 'brainDir', min: 1, max: 10_000, nullish: true },
                { kind: 'string', name: 'conversationId', min: 1, max: 2_000, nullish: true },
                { kind: 'string', name: 'sourceRevision', min: 1, max: 10_000, nullish: true },
              ],
            },
            key: {
              segments: [
                { kind: 'literal', value: 'antigravityCliPrint' },
                { kind: 'field', field: 'brainDir' },
              ],
            },
            instances: [{ kind: 'default', constants: {} }],
          }],
        },
      },
    }],
    managedDependencies: [{
      id: 'localharness',
      title: 'Antigravity localharness',
      description: 'Google Antigravity structured local runtime.',
      sources: [{
        kind: 'managedPypiWheelAsset',
        installId: ANTIGRAVITY_LOCALHARNESS_INSTALLABLE_KEY,
        distribution: 'google-antigravity',
        versionSpecifier: '>=0.1.4,<0.2.0',
        assetPathByPlatform: {
          'darwin-arm64': 'google/antigravity/bin/localharness',
          'linux-x64': 'google/antigravity/bin/localharness',
          'linux-arm64': 'google/antigravity/bin/localharness',
          'win32-x64': 'google/antigravity/bin/localharness.exe',
          'win32-arm64': 'google/antigravity/bin/localharness.exe',
        },
        executable: true,
        compatibilityProbe: 'antigravity-localharness-v1',
        installConsent: 'host_managed_required',
        autoUpdateMode: 'notify',
        trustedPublisher: 'Google',
      }],
      platforms: ['macos', 'linux', 'windows'],
      executable: 'localharness',
    }],
    systemTools: [{
      id: ANTIGRAVITY_CLI_SYSTEM_TOOL_ID,
      title: 'Antigravity CLI',
      executableNames: ['agy'],
    }],
    hooks: [{
      id: 'resolve-prerequisites',
      on: 'agent.resolvePrerequisites',
      hookApiVersion: 1,
      category: 'decision',
      scope: 'agent',
      filters: { agentId: 'antigravity' },
      executionKind: 'decide',
    }],
    settings: [ANTIGRAVITY_AGENT_SETTINGS_CONTRIBUTION],
  },
} satisfies PluginManifest;
