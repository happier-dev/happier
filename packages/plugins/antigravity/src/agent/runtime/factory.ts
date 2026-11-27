import type {
  AgentAcpRuntimeOptions, AgentLaunchEnvironment, AgentRuntimeFactory,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { compareVersions } from '@happier-dev/plugin-sdk/agents/runtime';

import { GEMINI_API_KEY_ENV } from '@happier-dev/plugin-sdk/connected-accounts';
import { ANTIGRAVITY_CLI_SYSTEM_TOOL_ID } from '../systemTool.js';
import { createAntigravityBackgroundContinuation } from './backgroundContinuation.js';
import { adoptAntigravityLegacyConversation } from './legacyConversation.js';
import { antigravityModelControls } from './modelControls.js';
import {
  ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_CONNECTED_MIN_VERSION, ANTIGRAVITY_FILE_TOKEN_STORAGE_ENV,
} from '../install/cliRuntime.js';
import { createAntigravityNativeTerminalSurface } from '../terminal/nativeSurface.js';

export { antigravityExternalSessionsContribution } from '../cliPrint/externalSessions.js';

const GEMINI_HOME_ENV = 'GEMINI_HOME';
const GEMINI_API_KEY_METHOD = 'gemini-api-key';

/** The one Antigravity launch decision for Sessions, resume and Execution Runs. */
export type AntigravityLaunch = Readonly<{
  /** Selected Connected Account (Google OAuth or Gemini API key). */
  connected: boolean;
  apiKey: boolean;
  /** Native `--gemini-dir` root; null keeps agy's default `~/.gemini`. */
  geminiDir: string | null;
  launchEnvironment: AgentLaunchEnvironment;
  options: AgentAcpRuntimeOptions;
}>;

function nonBlank(value: string | undefined): string | null {
  return value?.trim() ? value : null;
}

function supportsConnectedLaunch(version: string | null): boolean {
  const base = version?.trim().split(/[-+]/u, 1)[0];
  if (!base) return false;
  try { return compareVersions(base, ANTIGRAVITY_CONNECTED_MIN_VERSION) >= 0; }
  catch { return false; }
}

// Native refusal rendered as assistant text with end_turn (agy 1.5.18, invalid Gemini API key).
const NATIVE_API_KEY_INVALID = /^\u26A0 agent executor error: .*\bMessage: (.+?), Status: [A-Z_]+, .*\breason:API_KEY_INVALID\b/su;

export function resolveAntigravityLaunch(input: Readonly<{
  launchEnvironment?: AgentLaunchEnvironment;
  /** Inherited GEMINI_HOME read through the host; native agy ignores the variable itself. */
  inheritedGeminiHome?: string;
}>): AntigravityLaunch {
  const values = input.launchEnvironment?.values ?? {};
  const unset = input.launchEnvironment?.unset ?? [];
  const apiKey = nonBlank(values[GEMINI_API_KEY_ENV]) !== null;
  const connected = apiKey || values[ANTIGRAVITY_FILE_TOKEN_STORAGE_ENV] === '1';
  // A Connected Account always runs in its host-materialized home. Gemini API-key
  // authentication persists its method into the profile, so it must never touch
  // the machine profile or another account's profile.
  const materializedHome = Object.hasOwn(values, GEMINI_HOME_ENV) ? nonBlank(values[GEMINI_HOME_ENV]) : null;
  if (connected && !materializedHome) {
    throw new PluginError({ code: 'antigravity_connected_home_unavailable',
      message: 'The selected Antigravity account has no private profile on this machine. Select the account again to prepare it.' });
  }
  const geminiDir = materializedHome
    ?? (unset.includes(GEMINI_HOME_ENV) ? null : nonBlank(input.inheritedGeminiHome));
  const launchEnvironment: AgentLaunchEnvironment = connected
    ? { values: { ...values, [ANTIGRAVITY_FILE_TOKEN_STORAGE_ENV]: '1' }, unset: unset.filter(key => key !== ANTIGRAVITY_FILE_TOKEN_STORAGE_ENV) }
    // Machine sign-in keeps agy's own keyring selection.
    : {
        values: Object.fromEntries(Object.entries(values).filter(([key]) => key !== ANTIGRAVITY_FILE_TOKEN_STORAGE_ENV)),
        unset: [...new Set([...unset, ANTIGRAVITY_FILE_TOKEN_STORAGE_ENV])],
      };
  return {
    connected, apiKey, geminiDir, launchEnvironment,
    options: {
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: ANTIGRAVITY_CLI_SYSTEM_TOOL_ID },
        args: ['acp', ...(geminiDir ? ['--gemini-dir', geminiDir, '--app-data-dir', ANTIGRAVITY_APP_DATA_DIR] : [])],
      },
      definition: {
        auth: {
          selectMethod({ agentVersion }) {
            if (connected && !supportsConnectedLaunch(agentVersion ?? null)) {
              throw new PluginError({ code: 'antigravity_cli_update_required',
                message: `Update the Antigravity CLI to ${ANTIGRAVITY_CONNECTED_MIN_VERSION} or newer to use a connected account (found ${agentVersion?.trim() || 'an unknown version'}). Run \`agy update\` and try again.` });
            }
            // OAuth reads the profile token file; machine sign-in keeps agy's own selection.
            return apiKey ? { methodId: GEMINI_API_KEY_METHOD } : null;
          },
        },
        modelConfigOptionId: 'model',
        models: antigravityModelControls,
        sessionUpdates: {
          project: () => null,
          projectOutputDiagnostic(text) {
            const match = NATIVE_API_KEY_INVALID.exec(text.trim());
            if (!match) return null;
            const message = match[1]!;
            return { code: 'acp_turn_failed', severity: 'error', message, details: {
              failureCause: { phase: 'turn', failureReason: 'authentication_required', providerErrorMessage: message },
            } };
          },
        },
        mcp: { policy: 'pass_through' },
      },
    },
  };
}

function readInheritedGeminiHome(context: Readonly<{ services?: { exec?: { readEnvironment?(keys: readonly string[]): Readonly<Record<string, string>> } } }>): string | undefined {
  return context.services?.exec?.readEnvironment?.([GEMINI_HOME_ENV])[GEMINI_HOME_ENV];
}

export const createAntigravityAgentRuntime: AgentRuntimeFactory = () => ({
  surfaces: { terminal: createAntigravityNativeTerminalSurface() },
  sessions: {
    async open(request, context) {
      const launch = resolveAntigravityLaunch({
        launchEnvironment: request.launchEnvironment, inheritedGeminiHome: readInheritedGeminiHome(context),
      });
      if (request.kind === 'resume') {
        await adoptAntigravityLegacyConversation({ geminiDir: launch.geminiDir, conversationId: request.providerSessionId });
      }
      return await context.protocols.acp.open({ ...request, launchEnvironment: launch.launchEnvironment }, {
        ...launch.options,
        providerTurnSource: createAntigravityBackgroundContinuation(),
      });
    },
    executionRunContextV1: {
      async open(request, context) {
        const launch = resolveAntigravityLaunch({
          launchEnvironment: request.launchEnvironment, inheritedGeminiHome: readInheritedGeminiHome(context),
        });
        return await context.protocols.acp.openExecutionRunV1({ ...request, launchEnvironment: launch.launchEnvironment }, launch.options);
      },
    },
  },
});
