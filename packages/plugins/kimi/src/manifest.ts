import { projectAgentCapabilitiesV2FromDefinition } from '@happier-dev/plugin-sdk/agents';
import { definePlugin } from '@happier-dev/plugin-sdk';

import { AGENT_DEFINITION } from './agent/definition.js';
import { KIMI_ACP_COMMAND } from './agent/acp/preflight.js';
import { KIMI_SYSTEM_TOOL_READINESS } from './agent/readiness/declaration.js';
import { KIMI_TERMINAL_CONTRIBUTION } from './agent/terminal/contribution.js';
import { KIMI_UI_TRANSLATION_BUNDLES } from './ui/translations.js';

export const KIMI_PLUGIN = definePlugin({
  id: 'happier.agent.kimi',
  version: '0.0.0',
  displayName: 'Kimi',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'kimi-process',
      capability: 'process',
      reason: 'Run the declared Kimi CLI executable.',
      scope: {
        executables: [{ kind: 'systemTool', id: KIMI_ACP_COMMAND.toolId }],
      },
    }],
    optional: [],
  },
  agents: {
    kimi: {
      declaration: {
        title: { key: 'agentInput.agent.kimi', fallback: 'Kimi' },
        description: { key: 'profiles.aiBackend.kimiSubtitleExperimental', fallback: 'Kimi coding agent (experimental)' },
        runtime: {
          kind: 'acp',
          transport: {
            kind: 'stdio',
            executable: { kind: 'systemTool', id: 'kimi-cli' },
            args: [...KIMI_ACP_COMMAND.args],
            timeouts: { initializeMs: 90_000, idleMs: 500, toolCallMs: 120_000 },
          },
          definition: {
            modelConfigOptionId: 'model',
            mcp: { policy: 'pass_through' },
            stderrRules: {
              authenticationErrorDetail: 'Authentication error. Run `kimi login` to re-authenticate, then retry.',
            },
          },
        },
        cli: {
          displayName: 'Kimi Code CLI',
          executable: {
            binaryName: 'kimi',
            knownUserBinDirSuffixes: ['.local/bin'],
            sourcePreference: 'system-first',
            systemCommandResolutionStrategy: 'path-first',
          },
          install: {
            managed: null,
            manual: {
              kind: 'vendor_recipe',
              recipes: {
                darwin: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'] }],
                linux: [{ cmd: 'bash', args: ['-lc', 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'] }],
                win32: [{
                  cmd: 'powershell',
                  args: [
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-Command',
                    'Invoke-RestMethod https://code.kimi.com/kimi-code/install.ps1 | Invoke-Expression',
                  ],
                }],
              },
            },
            guideUrl: 'https://moonshotai.github.io/kimi-code/docs/en/reference/kimi-command.html',
            docsUrl: 'https://moonshotai.github.io/kimi-code/',
          },
          auth: {
            support: 'login_terminal',
            loginLaunches: [{ kind: 'primary', args: ['login'] }],
          },
        },
        primary: 'sessions',
        catalog: {
          vendorResume: { support: AGENT_DEFINITION.core.resume.vendorResume },
        },
        // Resume-only: current Kimi Code answers `session/list`, so the host
        // composes its own generic ACP session-listing producer for this
        // declaration. The source promises discovery for resume-in-Happier and
        // nothing else — no link, transcript, follow, takeover or writer-safety
        // claim — so this plugin contributes no External Sessions runtime.
        surfaces: {
          externalSession: {
            sources: [{
              sourceKind: 'kimiAcpSessionList',
              resumeOnly: true,
              schema: { fields: [{ kind: 'literal', name: 'kind', value: 'kimiAcpSessionList' }] },
              key: { segments: [{ kind: 'literal', value: 'kimiAcpSessionList' }] },
              instances: [{ kind: 'default', constants: {} }],
            }],
          },
        },
        capabilities: projectAgentCapabilitiesV2FromDefinition(AGENT_DEFINITION.core, {
          surfaces: ['externalSessions'],
          sessions: {
            open: ['create', 'resume'],
            delivery: ['newTurn', 'followUp'],
            cancel: true,
            configuration: true,
            executionRunContext: { versions: [1] },
          },
        }),
      },
      terminal: KIMI_TERMINAL_CONTRIBUTION,
    },
  },
  systemTools: {
    // Kimi Code installs one executable, `kimi`. The superseded Python
    // `kimi-cli` binary name is deliberately not resolvable: launching it would give
    // a runtime that negotiates neither the session controls nor the MCP
    // transport this Agent declares, and the host would then fail one operation
    // at a time instead of the install being visibly wrong. `kimi-cli` survives
    // only as a session `flavorAlias`, so existing Sessions still resolve.
    //
    // Selection is by observed command behavior, never by version output:
    // retired `kimi-cli` releases sort above current Kimi Code releases, and a
    // legacy install may even own the `kimi` name while answering `kimi acp`
    // without the `migrate` command surface. The host probes every runnable
    // `kimi` candidate with an ACP initialize fingerprint plus `migrate --help`,
    // selects the first current fingerprint, and otherwise fails with the
    // provider-owned guidance below. `kimi-cli` names only inform the legacy
    // diagnostic; they are never granted or launched. The declaration lives in
    // `agent/readiness/declaration.ts` so it stays independently testable.
    'kimi-cli': {
      title: 'Kimi Code CLI',
      executableNames: ['kimi'],
      readiness: KIMI_SYSTEM_TOOL_READINESS,
    },
  },
  ui: { translations: KIMI_UI_TRANSLATION_BUNDLES },
});

export const PLUGIN_MANIFEST = KIMI_PLUGIN.manifest;
