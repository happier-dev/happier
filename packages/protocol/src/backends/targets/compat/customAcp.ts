function normalizeLegacyAgent(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type LegacyCustomAcpAgentCarrier =
  | Readonly<{ kind: 'custom_acp_placeholder' }>
  | Readonly<{ kind: 'configured_backend'; configuredBackendId: string }>;

export function isLegacyCustomAcpId(value: unknown): boolean {
  return normalizeLegacyAgent(value) === 'customAcp';
}

function readLegacyConfiguredAcpBackendIdRaw(value: unknown): string | null {
  const legacyAgent = normalizeLegacyAgent(value);
  if (!legacyAgent || !legacyAgent.startsWith('acp:')) {
    return null;
  }
  const backendId = legacyAgent.slice('acp:'.length).trim();
  return backendId || null;
}

function isInvalidNestedLegacyCustomAcpPlaceholder(value: unknown): boolean {
  return readLegacyConfiguredAcpBackendIdRaw(value) === 'customAcp';
}

export function readLegacyCustomAcpAgentCarrier(value: unknown): LegacyCustomAcpAgentCarrier | null {
  if (isLegacyCustomAcpId(value)) {
    return { kind: 'custom_acp_placeholder' };
  }

  const configuredBackendId = readLegacyConfiguredAcpBackendIdRaw(value);
  if (!configuredBackendId || configuredBackendId === 'customAcp') {
    return null;
  }

  return {
    kind: 'configured_backend',
    configuredBackendId,
  };
}

export function readLegacyConfiguredAcpBackendId(value: unknown): string | null {
  const carrier = readLegacyCustomAcpAgentCarrier(value);
  return carrier?.kind === 'configured_backend' ? carrier.configuredBackendId : null;
}

export function isLegacyConfiguredAcpFlavorCarrier(value: unknown): boolean {
  return readLegacyConfiguredAcpBackendId(value) !== null;
}

export function isLegacyConfiguredAcpCompatible(params: Readonly<{
  legacyAgent: unknown;
  configuredBackendId: string;
}>): boolean {
  const normalizedLegacyAgent = normalizeLegacyAgent(params.legacyAgent);
  if (!normalizedLegacyAgent) {
    return true;
  }
  const carrier = readLegacyCustomAcpAgentCarrier(params.legacyAgent);
  if (!carrier) {
    return false;
  }
  return carrier.kind === 'custom_acp_placeholder'
    || carrier.configuredBackendId === params.configuredBackendId;
}

export function hasLegacyCustomAcpConcreteBackendId(value: Readonly<{
  backendId?: unknown;
  configuredBackendId?: unknown;
}>): boolean {
  return (
    readLegacyCustomAcpAgentCarrier(value.backendId) !== null
    || readLegacyCustomAcpAgentCarrier(value.configuredBackendId) !== null
    || isInvalidNestedLegacyCustomAcpPlaceholder(value.backendId)
    || isInvalidNestedLegacyCustomAcpPlaceholder(value.configuredBackendId)
  );
}
