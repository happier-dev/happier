export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function normalizeCodexHome(value: unknown): 'user' | 'connectedService' | null {
  return value === 'user' || value === 'connectedService' ? value : null;
}

export function normalizeCodexConnectedServiceFields(params: Readonly<{
  home: 'user' | 'connectedService' | null;
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  homePath: string | null;
}>): Readonly<{
  connectedServiceId: string | null;
  connectedServiceProfileId: string | null;
  homePath: string | null;
}> {
  if (params.home === 'connectedService') {
    return {
      connectedServiceId: params.connectedServiceId,
      connectedServiceProfileId: params.connectedServiceProfileId,
      homePath: params.homePath,
    };
  }
  return {
    connectedServiceId: null,
    connectedServiceProfileId: null,
    homePath: params.homePath,
  };
}
