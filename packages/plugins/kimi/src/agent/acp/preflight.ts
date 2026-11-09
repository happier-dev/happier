import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

export const KIMI_ACP_COMMAND = Object.freeze({ toolId: 'kimi-cli', args: Object.freeze(['acp']) });

export const KIMI_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  catalogs: Object.freeze({ kind: 'acp' as const, command: KIMI_ACP_COMMAND }),
} satisfies AgentPreflightSessionControlsContributionV1);
