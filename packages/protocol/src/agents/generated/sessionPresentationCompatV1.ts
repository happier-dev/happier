/**
 * GENERATED FILE CONTRACT (C8.1-session-presentation-compat)
 *
 * Protocol-safe projection of canonical Agent flavor aliases and vendor resume-id fields.
 * This file is emitted by:
 * - `scripts/migrations/extensions/generateBundledPluginEntries.ts`
 */

export const GENERATED_SESSION_PRESENTATION_COMPAT_V1 = Object.freeze([
  Object.freeze({
    agentId: 'antigravity',
    flavorAliases: Object.freeze(['antigravity', 'agy']),
    vendorResumeIdField: 'antigravitySessionId',
  }),
  Object.freeze({
    agentId: 'auggie',
    flavorAliases: Object.freeze(['auggie']),
    vendorResumeIdField: 'auggieSessionId',
  }),
  Object.freeze({
    agentId: 'claude',
    flavorAliases: Object.freeze(['claude']),
    vendorResumeIdField: 'claudeSessionId',
  }),
  Object.freeze({
    agentId: 'codex',
    flavorAliases: Object.freeze(['codex', 'codex-acp', 'codex-mcp', 'openai', 'gpt']),
    vendorResumeIdField: 'codexSessionId',
  }),
  Object.freeze({
    agentId: 'copilot',
    flavorAliases: Object.freeze(['copilot', 'github-copilot', 'copilot-cli']),
    vendorResumeIdField: 'copilotSessionId',
  }),
  Object.freeze({
    agentId: 'cursor',
    flavorAliases: Object.freeze(['cursor', 'cursor-agent']),
    vendorResumeIdField: 'cursorSessionId',
  }),
  Object.freeze({
    agentId: 'gemini',
    flavorAliases: Object.freeze(['gemini']),
    vendorResumeIdField: 'geminiSessionId',
  }),
  Object.freeze({
    agentId: 'grok',
    flavorAliases: Object.freeze(['grok', 'grok-build', 'grok-cli']),
    vendorResumeIdField: 'grokSessionId',
  }),
  Object.freeze({
    agentId: 'kilo',
    flavorAliases: Object.freeze(['kilo', 'kilocode']),
    vendorResumeIdField: 'kiloSessionId',
  }),
  Object.freeze({
    agentId: 'kimi',
    flavorAliases: Object.freeze(['kimi', 'kimi-cli']),
    vendorResumeIdField: 'kimiSessionId',
  }),
  Object.freeze({
    agentId: 'kiro',
    flavorAliases: Object.freeze(['kiro', 'kiro-cli']),
    vendorResumeIdField: 'kiroSessionId',
  }),
  Object.freeze({
    agentId: 'ohMyPi',
    flavorAliases: Object.freeze(['ohMyPi', 'oh-my-pi', 'omp']),
    vendorResumeIdField: 'ohMyPiSessionId',
  }),
  Object.freeze({
    agentId: 'opencode',
    flavorAliases: Object.freeze(['opencode', 'open-code']),
    vendorResumeIdField: 'opencodeSessionId',
  }),
  Object.freeze({
    agentId: 'pi',
    flavorAliases: Object.freeze(['pi', 'pi-coding-agent']),
    vendorResumeIdField: 'piSessionId',
  }),
  Object.freeze({
    agentId: 'qwen',
    flavorAliases: Object.freeze(['qwen', 'qwen-code']),
    vendorResumeIdField: 'qwenSessionId',
  }),
  Object.freeze({
    agentId: 'coderabbit',
    flavorAliases: Object.freeze(['coderabbit']),
    vendorResumeIdField: null,
  }),
  Object.freeze({
    agentId: 'deepsec',
    flavorAliases: Object.freeze(['deepsec']),
    vendorResumeIdField: null,
  }),
] as const);

function normalizePresentationIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function resolveGeneratedSessionPresentationAgentIdV1(
  metadata: Readonly<Record<string, unknown>>,
): string | null {
  const flavor = normalizePresentationIdentifier(metadata.flavor)?.toLowerCase() ?? null;
  if (flavor) {
    for (const entry of GENERATED_SESSION_PRESENTATION_COMPAT_V1) {
      if (entry.flavorAliases.some((alias) => alias.trim().toLowerCase() === flavor)) {
        return entry.agentId;
      }
    }
  }
  for (const entry of GENERATED_SESSION_PRESENTATION_COMPAT_V1) {
    if (!entry.vendorResumeIdField) continue;
    if (normalizePresentationIdentifier(metadata[entry.vendorResumeIdField])) return entry.agentId;
  }
  return null;
}
