import type { AgentExecutionRunOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';

/** Translate the host's admitted materialization, never select or acquire credentials. */
export function roborevRunnerAccess(request: AgentExecutionRunOpenRequest, agent: string, panel: string) {
  const env = { ...request.launchEnvironment?.values,
    ...Object.fromEntries((request.launchEnvironment?.unset ?? []).map(key => [key, ''])) };
  const binding = request.providerBinding;
  const model = binding?.model.id ?? request.modelSelection?.modelId;
  if (!binding && request.modelSelection?.providerConnectionId) return {
    status: 'unsupported' as const, code: 'roborev_provider_materialization_missing',
    message: 'The selected Provider was not materialized. Repair the selected account and retry.',
  };
  // A native panel shares its daemon's environment. The existing Review roster
  // must supply one run per selected runner; it owns account/member composition.
  if ((binding || request.runnerAgentTarget) && panel !== 'none') return { status: 'unsupported' as const, code: 'roborev_panel_account_unsupported',
    message: 'Choose one runner per Review roster entry to use selected accounts. A repository-defined native panel shares one login environment.' };
  if (!binding) return { status: 'ready' as const, env, model, config: '' };
  const unsupported = { status: 'unsupported' as const, code: 'roborev_provider_transport_unsupported',
    message: 'The native reviewer cannot preserve this selected runner credential transport. Choose another runner or account.' };
  if (agent === 'codex') {
    if (binding.materialization.kind === 'configFile') {
      return { status: 'ready' as const, env, model, config: '[agent.codex]\nignore_review_user_config = false\n' };
    }
    if (binding.materialization.kind !== 'engineConfig') return unsupported;
    const { modelProvider, config } = binding.materialization.engineConfig;
    // The Codex owner produced this native config. Only translate its container
    // into roborev's supported passthrough table; secrets stay in the host env.
    if (typeof modelProvider !== 'string' || !config || typeof config !== 'object' || Array.isArray(config)) return unsupported;
    return { status: 'ready' as const, env, model, config: '[agent.codex.config]\n'
      + `model_provider = ${JSON.stringify(modelProvider)}\n`
      + Object.entries(config).map(([key, value]) => `${key.split('.').map(part => JSON.stringify(part)).join('.')} = ${toml(value)}\n`).join('') };
  }
  if (agent === 'claude-code' && binding.materialization.kind === 'spawnEnv') {
    // v0.75.0 strips inherited Anthropic API keys and routing. Its explicit
    // model@URL route forwards only ROBOREV_CLAUDE_PROXY_TOKEN as bearer auth.
    if (!env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_CUSTOM_HEADERS || !binding.upstream.normalizedUrl) return unsupported;
    return { status: 'ready' as const,
      env: { ...env, ROBOREV_CLAUDE_PROXY_TOKEN: env.ANTHROPIC_AUTH_TOKEN },
      model: `${model}@${binding.upstream.normalizedUrl}`, config: '' };
  }
  return unsupported;
}

function toml(value: JsonValue): string {
  if (value === null) throw new Error('roborev cannot encode a null native configuration value');
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
  if (typeof value === 'object') return `{ ${Object.entries(value).map(([key, field]) => `${JSON.stringify(key)} = ${toml(field)}`).join(', ')} }`;
  return JSON.stringify(value);
}
