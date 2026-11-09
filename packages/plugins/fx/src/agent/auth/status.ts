import type { AgentCliAuthCommandResultV1, AgentCliAuthContributionV1, AgentCliAuthStatusV1 } from '@happier-dev/plugin-sdk/agents/runtime';

export const FX_AUTH_STATUS_COMMAND = Object.freeze({ toolId: 'fx-cli', args: ['status', '--json'] as const });

type FxStatus = Readonly<{
  status: AgentCliAuthStatusV1;
  credentialSource: string | null;
  model: string | null;
}>;

/** FX 0.0.14 / 1a070af32cdf: src/core/output/output_contracts.zig#StatusSnapshot. */
export function parseFxStatusCommand(result: AgentCliAuthCommandResultV1): FxStatus {
  const unknown: FxStatus = { status: { state: 'unknown', reason: 'probe_failed', source: 'command' }, credentialSource: null, model: null };
  if (!result.ok || result.exitCode !== 0) return unknown;
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { return unknown; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown;
  const kind = Reflect.get(value, 'kind');
  const auth = Reflect.get(value, 'auth');
  const refreshable = Reflect.get(value, 'auth_refreshable');
  const expired = Reflect.get(value, 'auth_expired');
  const model = Reflect.get(value, 'model');
  if (kind !== 'status' || typeof auth !== 'string' || typeof refreshable !== 'boolean'
    || (expired !== undefined && typeof expired !== 'boolean')
    || (model !== undefined && typeof model !== 'string')) return unknown;
  const facts = { credentialSource: auth, model: typeof model === 'string' ? model : null };
  if (auth === 'missing') return { ...facts, status: { state: 'logged_out', reason: 'missing_credentials', source: 'command' } };
  // This mode delegates authentication to an embedding host and supplies no
  // credential itself; its presence is not evidence of a native CLI login.
  if (auth === 'host managed') return { ...facts, status: { state: 'unknown', reason: 'not_configured', source: 'command' } };
  const method = auth === 'AI_GATEWAY_API_KEY' ? 'api_key_env'
    : auth === 'VERCEL_OIDC_TOKEN' ? 'auth_token_env'
      : ['fx login', 'Codex subscription', 'Grok subscription'].includes(auth) ? 'oauth_cli'
        : /^stored API key \([^\r\n]+\)$/u.test(auth) ? 'unknown'
          : auth === 'configured provider' ? 'config_file' : null;
  if (!method) return unknown;
  return { ...facts, status: expired
    ? { state: 'logged_out', reason: 'expired', source: 'command' }
    : { state: 'logged_in', method, source: 'command' } };
}

export const FX_CLI_AUTH = Object.freeze({
  async detectAuthStatus({ runDeclaredSystemToolCommand }) {
    return parseFxStatusCommand(await runDeclaredSystemToolCommand(FX_AUTH_STATUS_COMMAND)).status;
  },
} satisfies AgentCliAuthContributionV1);
