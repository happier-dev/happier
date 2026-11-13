import type { AgentAcpRuntimeOptions, AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

import { createAntigravityNativeTerminalSurface } from '../terminal/nativeSurface.js';

export { antigravityExternalSessionsContribution } from '../cliPrint/externalSessions.js';

export function buildAntigravityAcpRuntimeOptions(
  launchEnvironment: Readonly<Record<string, string>>,
): AgentAcpRuntimeOptions {
  return {
    transport: {
      kind: 'stdio',
      executable: { kind: 'managedDependency', id: 'agy-acp-server' },
    },
    definition: {
      auth: {
        selectMethod: () => ({ methodId: launchEnvironment.GEMINI_API_KEY?.trim() ? 'gemini-api-key' : 'oauth-personal' }),
        // ACP 1.3.0 marks failed refresh/onboarding separately from generic missing authentication.
        setupFailure: { requestErrorCode: -32000, dataReason: 'onboarding_failed' },
      },
      sessionUpdates: {
        project: () => null,
        projectOutputDiagnostic(text) {
          // The native Gemini refusal is emitted as assistant text with end_turn.
          const message = text.trim();
          if (message !== 'API key not valid. Please pass a valid API key.') return null;
          return { code: 'acp_turn_failed', severity: 'error', message, details: {
            failureCause: { phase: 'turn', failureReason: 'authentication_required', providerErrorMessage: message },
          } };
        },
      },
      mcp: { policy: 'pass_through' },
      // Rendered diagnostic in the pinned ACP 1.3.0 quota_errors.py; advisory reset prose never creates a reset instant.
      usageLimitDiagnostic: {
        pattern: String.raw`^Usage Limit Reached\n\nYou have reached your current quota for this period\.(?: Your limit will reset (?:in \d+ (?:days?|hours?|minutes?|seconds?)(?:, \d+ (?:days?|hours?|minutes?|seconds?))?|on [A-Z][a-z]{2} \d{1,2}, \d{4} \d{2}:\d{2} UTC)\.)?$`,
        connectedAccountService: { pluginId: 'happier.agent.antigravity', localId: 'antigravity-account' },
      },
    },
  };
}

export const createAntigravityAgentRuntime: AgentRuntimeFactory = () => ({
  surfaces: { terminal: createAntigravityNativeTerminalSurface() },
  sessions: {
    async open(request, context) {
      return await context.protocols.acp.open(request,
        buildAntigravityAcpRuntimeOptions(request.launchEnvironment?.values ?? {}));
    },
    executionRunContextV1: {
      async open(request, context) {
        return await context.protocols.acp.openExecutionRunV1(request,
          buildAntigravityAcpRuntimeOptions(request.launchEnvironment?.values ?? {}));
      },
    },
  },
});
