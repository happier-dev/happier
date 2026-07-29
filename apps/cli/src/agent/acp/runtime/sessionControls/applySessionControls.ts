import { logger } from '@/ui/logger';
import { getAgentModelConfig, type AgentId } from '@happier-dev/agents';

const DEFAULT_SESSION_CONTROL_TIMEOUT_MS = 15_000;

type AcpRuntimeSessionControlBackend = Readonly<{
  setSessionMode?: (sessionId: string, modeId: string) => Promise<void>;
  setSessionModel?: (
    sessionId: string,
    modelId: string,
    requestMeta?: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  setSessionConfigOption?: (
    sessionId: string,
    configId: string,
    value: string,
  ) => Promise<unknown>;
}>;

type AcpRuntimeSessionControlContext = Readonly<{
  provider: string;
  getSessionId: () => string | null;
  ensureBackend: () => Promise<AcpRuntimeSessionControlBackend>;
}>;

function resolveSessionControlTimeoutMs(): number {
  const raw = (process.env.HAPPIER_ACP_SESSION_CONTROL_TIMEOUT_MS ?? '').toString().trim();
  if (!raw) return DEFAULT_SESSION_CONTROL_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SESSION_CONTROL_TIMEOUT_MS;
  return Math.trunc(parsed);
}

function resolveModelConfigOptionId(provider: string): string {
  try {
    return getAgentModelConfig(provider as AgentId).acpModelConfigOptionId ?? 'model';
  } catch (error) {
    logger.debug(
      `[${provider}] Failed to resolve provider model config option id; falling back to "model"`,
      error
    );
    return 'model';
  }
}

function normalizeSessionConfigOptionValue(value: string | number | boolean | null): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

export async function applyAcpRuntimeSessionMode(
  context: AcpRuntimeSessionControlContext,
  modeId: string,
): Promise<void> {
  const normalizedModeId = typeof modeId === 'string' ? modeId.trim() : '';
  if (!normalizedModeId) return;

  const sessionId = context.getSessionId();
  if (!sessionId) {
    throw new Error(`${context.provider} ACP session was not started`);
  }

  const backend = await context.ensureBackend();
  if (!backend.setSessionMode) return;
  await backend.setSessionMode(sessionId, normalizedModeId);
}

export async function applyAcpRuntimeSessionModel(
  context: AcpRuntimeSessionControlContext,
  modelId: string,
  requestMeta?: Readonly<Record<string, unknown>>,
): Promise<void> {
  const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
  if (!normalizedModelId) return;

  const sessionId = context.getSessionId();
  if (!sessionId) {
    throw new Error(`${context.provider} ACP session was not started`);
  }

  const controlTimeoutMs = resolveSessionControlTimeoutMs();
  const modelConfigOptionId = resolveModelConfigOptionId(context.provider);
  const backend = await context.ensureBackend();

  if (backend.setSessionModel) {
    const timeoutPromise = new Promise<{ ok: false; error: Error }>((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, error: new Error('ACP session/set_model timed out') }),
        controlTimeoutMs,
      );
      timer.unref?.();
    });

    const outcome = await Promise.race([
      backend
        .setSessionModel(sessionId, normalizedModelId, requestMeta)
        .then(() => ({ ok: true as const }))
        .catch((error) => ({ ok: false as const, error })),
      timeoutPromise,
    ]);
    if (outcome.ok) return;

    const error = outcome.error;
    // Some ACP agents may not support `session/set_model` but may expose an equivalent
    // `model` config option. Fall back best-effort; callers already treat this as non-fatal.
    if (requestMeta || !backend.setSessionConfigOption) throw error;

    try {
      await backend.setSessionConfigOption(sessionId, modelConfigOptionId, normalizedModelId);
      return;
    } catch {
      // If the fallback also fails, surface the original error so callers can retry.
      throw error;
    }
  }

  if (backend.setSessionConfigOption) {
    await backend.setSessionConfigOption(sessionId, modelConfigOptionId, normalizedModelId);
  }
}

export async function applyAcpRuntimeSessionConfigOption(
  context: AcpRuntimeSessionControlContext,
  configId: string,
  value: string | number | boolean | null,
): Promise<void> {
  const normalizedConfigId = typeof configId === 'string' ? configId.trim() : '';
  if (!normalizedConfigId) return;

  const normalizedValue = normalizeSessionConfigOptionValue(value);
  if (!normalizedValue) return;

  const sessionId = context.getSessionId();
  if (!sessionId) return;

  const backend = await context.ensureBackend();
  if (!backend.setSessionConfigOption) return;
  await backend.setSessionConfigOption(sessionId, normalizedConfigId, normalizedValue);
}
