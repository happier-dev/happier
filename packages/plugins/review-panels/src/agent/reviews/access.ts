import type { AgentExecutionRunOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';

/** Translate the host's admitted materialization, never select or acquire credentials. */
export function roborevRunnerAccess(request: AgentExecutionRunOpenRequest, agent: string, panel: string) {
  const env = { ...request.launchEnvironment?.values,
    ...Object.fromEntries((request.launchEnvironment?.unset ?? []).map(key => [key, ''])) };
  const binding = request.providerBinding;
  const materialization = binding?.materialization ?? request.runnerConnectedAccountMaterialization;
  const selectedAccount = Boolean(request.runnerConnectedAccountPurposes?.length);
  const unsupportedAccount = { status: 'unsupported' as const, code: 'roborev_runner_account_unsupported',
    message: 'The native reviewer cannot preserve this selected runner account. Choose another runner or account.' };
  const model = binding?.model.id ?? request.modelSelection?.modelId;
  if (!binding && request.modelSelection?.providerConnectionId) return {
    status: 'unsupported' as const, code: 'roborev_provider_materialization_missing',
    message: 'The selected Provider was not materialized. Repair the selected account and retry.',
  };
  // A native panel shares its daemon's environment. The existing Review roster
  // must supply one run per selected runner; it owns account/member composition.
  if ((binding || request.runnerAgentTarget) && panel !== 'none') return { status: 'unsupported' as const, code: 'roborev_panel_account_unsupported',
    message: 'Choose one runner per Review roster entry to use selected accounts. A repository-defined native panel shares one login environment.' };
  if (selectedAccount && !materialization) return unsupportedAccount;
  if (!binding && !selectedAccount) return { status: 'ready' as const, env, model, config: '' };
  const unsupported = { status: 'unsupported' as const, code: 'roborev_provider_transport_unsupported',
    message: 'The native reviewer cannot preserve this selected runner credential transport. Choose another runner or account.' };
  const refusal = selectedAccount ? unsupportedAccount : unsupported;
  if (agent === 'codex') {
    if (materialization?.kind === 'configFile') {
      return { status: 'ready' as const, env, model, config: '[agent.codex]\nignore_review_user_config = false\n' };
    }
    if (materialization?.kind !== 'engineConfig') return refusal;
    const { modelProvider, config } = materialization.engineConfig;
    // The Codex owner produced this native config. Only translate its container
    // into roborev's supported passthrough table; secrets stay in the host env.
    if (typeof modelProvider !== 'string' || !config || typeof config !== 'object' || Array.isArray(config)) return refusal;
    return { status: 'ready' as const, env, model, config: '[agent.codex.config]\n'
      + `model_provider = ${JSON.stringify(modelProvider)}\n`
      + Object.entries(config).map(([key, value]) => `${key.split('.').map(part => JSON.stringify(part)).join('.')} = ${toml(value)}\n`).join('') };
  }
  if (agent === 'claude-code' && materialization?.kind === 'spawnEnv') {
    if (!binding) return env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN
      ? { status: 'ready' as const, env, model, config: '' } : unsupportedAccount;
    // v0.75.0 strips inherited Anthropic API keys and routing. Its explicit
    // model@URL route forwards only ROBOREV_CLAUDE_PROXY_TOKEN as bearer auth.
    if (!env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_CUSTOM_HEADERS || !binding.upstream.normalizedUrl) return unsupported;
    return { status: 'ready' as const,
      env: { ...env, ROBOREV_CLAUDE_PROXY_TOKEN: env.ANTHROPIC_AUTH_TOKEN },
      model: `${model}@${binding.upstream.normalizedUrl}`, config: '' };
  }
  return refusal;
}

function toml(value: JsonValue): string {
  if (value === null) throw new Error('roborev cannot encode a null native configuration value');
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  if (typeof value === 'object') return `{ ${Object.entries(value).map(([key, field]) => `${JSON.stringify(key)} = ${toml(field)}`).join(', ')} }`;
  return JSON.stringify(value);
}
