import { readCanonicalAntigravityRuntimeDescriptorV1 } from '../runtime/runtimeDescriptor.js';

export const ANTIGRAVITY_RUNTIME_MODES = ['auto', 'cliPrint', 'sdk'] as const;
export type AntigravityRuntimeMode = (typeof ANTIGRAVITY_RUNTIME_MODES)[number];
export type ConcreteAntigravityRuntimeMode = 'cliPrint' | 'sdk';

export const HAPPIER_ANTIGRAVITY_RUNTIME_MODE_ENV_KEY = 'HAPPIER_ANTIGRAVITY_RUNTIME_MODE';

export type AntigravityRuntimeModeSource =
  | 'runtimeDescriptor'
  | 'metadata'
  | 'accountSettings'
  | 'env'
  | 'default'
  | 'auto';

export type AntigravityRuntimeModeProbeContext = Readonly<{
  cwd?: string | null;
  env?: Readonly<Record<string, string | undefined>> | null;
  signal?: AbortSignal;
}>;

export type AntigravityRuntimeModeProbes = Readonly<{
  isCliPrintAvailable(context: AntigravityRuntimeModeProbeContext): boolean | Promise<boolean>;
  hasSdkCredentials(context: AntigravityRuntimeModeProbeContext): boolean | Promise<boolean>;
}>;

export type AntigravityRuntimeModeResolution =
  | Readonly<{
      status: 'resolved';
      mode: ConcreteAntigravityRuntimeMode;
      requestedMode: AntigravityRuntimeMode | ConcreteAntigravityRuntimeMode;
      source: AntigravityRuntimeModeSource;
    }>
  | Readonly<{
      status: 'setup_required';
      requestedMode: AntigravityRuntimeMode;
      source: AntigravityRuntimeModeSource;
      reasonCode: 'antigravity_runtime_unavailable';
      diagnostic: string;
    }>;

export type AntigravityRuntimeModeRequest = Readonly<{
  runtimeDescriptorV1?: unknown;
  metadata?: Readonly<Record<string, unknown>> | null;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  env?: Readonly<Record<string, string | undefined>> | null;
  cwd?: string | null;
  signal?: AbortSignal;
  probes: AntigravityRuntimeModeProbes;
}>;

export function normalizeAntigravityRuntimeMode(value: unknown): AntigravityRuntimeMode | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === 'auto' || trimmed === 'cliPrint' || trimmed === 'sdk' ? trimmed : null;
}

export function isConcreteAntigravityRuntimeMode(
  value: AntigravityRuntimeMode | null | undefined,
): value is ConcreteAntigravityRuntimeMode {
  return value === 'cliPrint' || value === 'sdk';
}

function readEnvRuntimeMode(env: Readonly<Record<string, string | undefined>> | null | undefined): unknown {
  return env?.[HAPPIER_ANTIGRAVITY_RUNTIME_MODE_ENV_KEY];
}

function readMetadataRuntimeDescriptor(metadata: Readonly<Record<string, unknown>> | null | undefined): unknown {
  return metadata?.runtimeDescriptorV1 ?? metadata?.agentRuntimeDescriptorV1 ?? null;
}

export function resolveAntigravityRuntimeModeRequest(params: Readonly<{
  runtimeDescriptorV1?: unknown;
  metadata?: Readonly<Record<string, unknown>> | null;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  env?: Readonly<Record<string, string | undefined>> | null;
}>): Readonly<{
  requestedMode: AntigravityRuntimeMode;
  source: Exclude<AntigravityRuntimeModeSource, 'auto'>;
}> {
  const runtimeDescriptor = readCanonicalAntigravityRuntimeDescriptorV1(
    params.runtimeDescriptorV1 ?? readMetadataRuntimeDescriptor(params.metadata),
  );
  if (isConcreteAntigravityRuntimeMode(runtimeDescriptor?.runtimeMode)) {
    return { requestedMode: runtimeDescriptor.runtimeMode, source: 'runtimeDescriptor' };
  }

  const metadataMode = normalizeAntigravityRuntimeMode(params.metadata?.antigravityRuntimeMode);
  if (metadataMode) return { requestedMode: metadataMode, source: 'metadata' };

  const accountSettingsMode = normalizeAntigravityRuntimeMode(params.accountSettings?.antigravityRuntimeMode);
  if (accountSettingsMode) return { requestedMode: accountSettingsMode, source: 'accountSettings' };

  const envMode = normalizeAntigravityRuntimeMode(readEnvRuntimeMode(params.env));
  if (envMode) return { requestedMode: envMode, source: 'env' };

  return { requestedMode: 'auto', source: 'default' };
}

export async function resolveAntigravityRuntimeMode(
  params: AntigravityRuntimeModeRequest,
): Promise<AntigravityRuntimeModeResolution> {
  const request = resolveAntigravityRuntimeModeRequest(params);
  const probeContext = {
    cwd: params.cwd,
    env: params.env,
    signal: params.signal,
  };
  if (request.requestedMode === 'cliPrint') {
    if (await params.probes.isCliPrintAvailable(probeContext)) {
      return {
        status: 'resolved',
        mode: 'cliPrint',
        requestedMode: 'cliPrint',
        source: request.source,
      };
    }
    return {
      status: 'setup_required',
      requestedMode: 'cliPrint',
      source: request.source,
      reasonCode: 'antigravity_runtime_unavailable',
      diagnostic: 'Antigravity CLI print mode requires a usable authenticated Antigravity CLI runtime.',
    };
  }
  if (request.requestedMode === 'sdk') {
    if (await params.probes.hasSdkCredentials(probeContext)) {
      return {
        status: 'resolved',
        mode: 'sdk',
        requestedMode: 'sdk',
        source: request.source,
      };
    }
    return {
      status: 'setup_required',
      requestedMode: 'sdk',
      source: request.source,
      reasonCode: 'antigravity_runtime_unavailable',
      diagnostic: 'Antigravity SDK mode requires Gemini API / Vertex credentials.',
    };
  }

  if (await params.probes.isCliPrintAvailable(probeContext)) {
    return {
      status: 'resolved',
      mode: 'cliPrint',
      requestedMode: 'auto',
      source: 'auto',
    };
  }
  if (await params.probes.hasSdkCredentials(probeContext)) {
    return {
      status: 'resolved',
      mode: 'sdk',
      requestedMode: 'auto',
      source: 'auto',
    };
  }
  return {
    status: 'setup_required',
    requestedMode: 'auto',
    source: 'auto',
    reasonCode: 'antigravity_runtime_unavailable',
    diagnostic: 'Antigravity requires either an authenticated Antigravity CLI runtime or Gemini API / Vertex credentials.',
  };
}
