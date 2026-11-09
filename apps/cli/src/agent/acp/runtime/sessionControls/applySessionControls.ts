import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { normalizeSessionConfigOptionValue } from '../../sessionSettings/sessionSettingsState';

type AcpRuntimeSessionControlBackend = Readonly<{
  setSessionMode?: (sessionId: string, modeId: string) => Promise<void>;
  setSessionModel?: (
    sessionId: string,
    modelId: string,
    requestMeta?: Readonly<Record<string, unknown>>,
    selection?: Readonly<{ allowUnlisted: boolean }>,
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

export async function applyAcpRuntimeSessionMode(
  context: AcpRuntimeSessionControlContext,
  modeId: string,
): Promise<void> {
  const normalizedModeId = readNonBlankOpaqueIdentifier(modeId);
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
  selection?: Readonly<{ allowUnlisted: boolean }>,
): Promise<void> {
  const normalizedModelId = readNonBlankOpaqueIdentifier(modelId);
  if (!normalizedModelId) return;

  const sessionId = context.getSessionId();
  if (!sessionId) {
    throw new Error(`${context.provider} ACP session was not started`);
  }

  const backend = await context.ensureBackend();
  await backend.setSessionModel?.(sessionId, normalizedModelId, requestMeta, selection);
}

export async function applyAcpRuntimeSessionConfigOption(
  context: AcpRuntimeSessionControlContext,
  configId: string,
  value: string | number | boolean | null,
): Promise<void> {
  const normalizedConfigId = readNonBlankOpaqueIdentifier(configId);
  if (!normalizedConfigId) return;

  const normalizedValue = normalizeSessionConfigOptionValue(value);
  if (normalizedValue === null) return;

  const sessionId = context.getSessionId();
  if (!sessionId) return;

  const backend = await context.ensureBackend();
  if (!backend.setSessionConfigOption) return;
  await backend.setSessionConfigOption(sessionId, normalizedConfigId, normalizedValue);
}
