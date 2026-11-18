import type { AgentCliAuthContributionV1, AgentCliAuthStatusV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { CODERABBIT_SYSTEM_TOOL_ID } from './reviews/systemTool.js';

/** CodeRabbit 0.9.5 `auth status --agent`, observed in an isolated unauthenticated home. */
export const CODERABBIT_CLI_AUTH = Object.freeze({
  async detectAuthStatus({ runDeclaredSystemToolCommand }) {
    const unknown: AgentCliAuthStatusV1 = { state: 'unknown', reason: 'probe_failed', source: 'command' };
    const result = await runDeclaredSystemToolCommand({ toolId: CODERABBIT_SYSTEM_TOOL_ID, args: ['auth', 'status', '--agent'] });
    if (!result.ok || result.exitCode !== 0) return unknown;
    let value: unknown;
    try { value = JSON.parse(result.stdout); } catch { return unknown; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown;
    if (Reflect.get(value, 'type') !== 'status' || Reflect.get(value, 'phase') !== 'auth') return unknown;
    const authenticated = Reflect.get(value, 'authenticated');
    // Deliberately publish no native account, organization or credential details.
    if (authenticated === true) return { state: 'logged_in', method: 'unknown', source: 'command' };
    if (authenticated === false) return { state: 'logged_out', reason: 'missing_credentials', source: 'command' };
    return unknown;
  },
} satisfies AgentCliAuthContributionV1);
