import { envFlag } from '../../env';

import type { ProviderScenario, ProviderUnderTest } from '../types';

type AcpPermissions = NonNullable<ProviderUnderTest['permissions']>['acp'];

export function buildProviderDevCommandArgs(params: Readonly<{
  providerSubcommand: string;
  sessionId: string;
  yoloCliArgs: readonly string[];
  permissionCliArgs: readonly string[];
  modelCliArgs: readonly string[];
  extraCliArgs: readonly string[];
  scenarioCliArgs: readonly string[];
  providerCliExtraArgs: readonly string[];
}>): string[] {
  return [
    '-s',
    'workspace',
    '@happier-dev/cli',
    'dev',
    params.providerSubcommand,
    '--existing-session',
    params.sessionId,
    ...params.yoloCliArgs,
    ...params.permissionCliArgs,
    ...params.modelCliArgs,
    ...params.providerCliExtraArgs,
    ...params.scenarioCliArgs,
    ...params.extraCliArgs,
  ];
}

export function resolveCodexCliPermissionArgs(params: {
  providerSubcommand: string;
  yolo: boolean;
  scenarioMeta: Record<string, unknown>;
}): string[] {
  if (params.providerSubcommand !== 'codex') return [];

  const raw = params.scenarioMeta.permissionMode;
  const modeFromMeta = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
  const mode = modeFromMeta ?? (params.yolo ? 'yolo' : null);
  if (!mode) return [];

  const updatedAtRaw = params.scenarioMeta.permissionModeUpdatedAt;
  const updatedAt = typeof updatedAtRaw === 'number' && Number.isFinite(updatedAtRaw) && updatedAtRaw > 0
    ? Math.floor(updatedAtRaw)
    : Date.now();

  return ['--permission-mode', mode, '--permission-mode-updated-at', String(updatedAt)];
}

export function resolveYoloCliArgs(params: {
  providerSubcommand: string;
  yolo: boolean;
  hasExplicitPermissionModeArgs: boolean;
}): string[] {
  if (!params.yolo) return [];
  if (params.hasExplicitPermissionModeArgs && params.providerSubcommand === 'codex') {
    return [];
  }
  return ['--yolo'];
}

function normalizeProviderModelEnvSuffix(providerId: string): string {
  return providerId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseProviderModelOverridesMap(raw: string | undefined, providerId: string): string | null {
  const source = typeof raw === 'string' ? raw.trim() : '';
  if (!source) return null;
  const target = providerId.trim().toLowerCase();
  if (!target) return null;

  const entries = source
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const splitIndex = entry.indexOf('=');
    if (splitIndex <= 0) continue;
    const key = entry.slice(0, splitIndex).trim().toLowerCase();
    const value = entry.slice(splitIndex + 1).trim();
    if (key === target && value.length > 0) return value;
  }
  return null;
}

export function resolveProviderModelCliArgs(params: {
  providerId: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: () => number;
}): string[] {
  const env = params.env ?? process.env;
  const providerSuffix = normalizeProviderModelEnvSuffix(params.providerId);
  const providerModel =
    env[`HAPPIER_E2E_PROVIDER_MODEL_${providerSuffix}`] ??
    env[`HAPPY_E2E_PROVIDER_MODEL_${providerSuffix}`] ??
    null;
  const mappedModel =
    parseProviderModelOverridesMap(
      env.HAPPIER_E2E_PROVIDER_MODELS ?? env.HAPPY_E2E_PROVIDER_MODELS,
      params.providerId,
    ) ?? null;
  const globalModel = env.HAPPIER_E2E_PROVIDER_MODEL ?? env.HAPPY_E2E_PROVIDER_MODEL ?? null;
  const model = [providerModel, mappedModel, globalModel]
    .find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)
    ?.trim();
  if (!model) return [];

  const now = Math.floor((params.nowMs ?? Date.now)());
  return ['--model', model, '--model-updated-at', String(now)];
}

export function resolveAllowPermissionAutoApproveInYolo(params: {
  provider: ProviderUnderTest;
  scenario: ProviderScenario;
  scenarioMeta: Record<string, unknown>;
  yolo: boolean;
  resolvePromptExpectation: (params: {
    acpPermissions: AcpPermissions | undefined;
    mode: 'default' | 'safe-yolo' | 'read-only' | 'yolo' | 'plan';
  }) => boolean;
}): boolean {
  if (params.scenario.allowPermissionAutoApproveInYolo === true) return true;
  if (!params.yolo || params.provider.protocol !== 'acp') return false;

  const raw = params.scenarioMeta.permissionMode;
  const mode =
    typeof raw === 'string' && (raw === 'default' || raw === 'safe-yolo' || raw === 'read-only' || raw === 'yolo' || raw === 'plan')
      ? raw
      : params.yolo
        ? 'yolo'
        : 'default';
  return params.resolvePromptExpectation({
    acpPermissions: params.provider.permissions?.acp,
    mode,
  });
}

export function resolveYoloForScenario(scenario: ProviderScenario): boolean {
  if (typeof scenario.yolo === 'boolean') return scenario.yolo;
  return envFlag('HAPPIER_E2E_PROVIDER_YOLO_DEFAULT', true);
}
