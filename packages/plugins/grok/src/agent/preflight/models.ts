import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { selectGrokAuthenticationFromFacts } from '../acp/auth.js';

export const GROK_ACP_COMMAND = Object.freeze({ toolId: 'grok-cli', args: Object.freeze(['--no-auto-update', 'agent', 'stdio']) });

type GrokPreflightModel = Readonly<{
  id: string;
  name: string;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const GROK_MODELS_COMMAND_ARGS = ['models'] as const;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,255}$/u;

function isSafeModelId(value: string): boolean {
  return MODEL_ID_PATTERN.test(value)
    && value.split('/').every((segment) => segment !== '.' && segment !== '..');
}

function formatModelName(modelId: string): string {
  return modelId
    .split(/[-_/:]+/u)
    .filter(Boolean)
    .map((part) => part.toLowerCase() === 'grok'
      ? 'Grok'
      : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function parseGrokModelsOutput(outputRaw: string): readonly GrokPreflightModel[] | null {
  const lines = outputRaw.split(/\r?\n/u);
  const sectionIndex = lines.findIndex((line) => line.trim() === 'Available models:');
  if (sectionIndex < 0) return null;

  const models: GrokPreflightModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of lines.slice(sectionIndex + 1)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(?:\*\s+)?([^\s]+)(?:\s+\(default\))?$/u.exec(line);
    const modelId = match?.[1] ?? '';
    if (!isSafeModelId(modelId) || seen.has(modelId)) return null;
    seen.add(modelId);
    models.push(Object.freeze({ id: modelId, name: formatModelName(modelId) }));
  }
  return models.length > 0 ? Object.freeze(models) : null;
}

export const GROK_PREFLIGHT_SESSION_CONTROLS = Object.freeze({
  catalogs: Object.freeze({
    kind: 'acp' as const,
    command: GROK_ACP_COMMAND,
    selectAuthentication({ initializeResult, probe }) {
      const initialized = isRecord(initializeResult) ? initializeResult : {};
      const methods = Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
      return selectGrokAuthenticationFromFacts({
        advertisedMethodIds: methods.flatMap((method) => isRecord(method) && typeof method.id === 'string' ? [method.id] : []),
        initializeMetadata: isRecord(initialized._meta) ? initialized._meta : null,
      }, { hasApiKey: probe.nonblankEnvironment?.XAI_API_KEY === true });
    },
  }),
  models: Object.freeze({
    command: Object.freeze({
      toolId: 'grok-cli',
      args: GROK_MODELS_COMMAND_ARGS,
      ci: 'omit',
    }),
    parseOutput: ({ stdout, stderr }) =>
      parseGrokModelsOutput(stdout) ?? parseGrokModelsOutput(stderr),
  }),
} satisfies AgentPreflightSessionControlsContributionV1);
