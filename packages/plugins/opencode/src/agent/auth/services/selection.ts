export const OPEN_CODE_SUPPORTED_AUTH_SERVICE_IDS = Object.freeze([
  'openai-codex',
  'openai',
  'claude-subscription',
  'anthropic',
] as const);

export type OpenCodeSupportedAuthServiceId = typeof OPEN_CODE_SUPPORTED_AUTH_SERVICE_IDS[number];

export function isOpenCodeSupportedAuthServiceId(value: unknown): value is OpenCodeSupportedAuthServiceId {
  return typeof value === 'string'
    && (OPEN_CODE_SUPPORTED_AUTH_SERVICE_IDS as readonly string[]).includes(value);
}

export function readOpenCodeConnectedServiceId(selection: unknown): OpenCodeSupportedAuthServiceId | null {
  if (isOpenCodeSupportedAuthServiceId(selection)) return selection;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return null;
  const serviceId = (selection as Readonly<Record<string, unknown>>).serviceId;
  return isOpenCodeSupportedAuthServiceId(serviceId) ? serviceId : null;
}

export function createOpenCodeAuthMaterializationInput<TRecord>(
  serviceId: OpenCodeSupportedAuthServiceId,
  record: TRecord,
): Readonly<{
  openaiCodex: TRecord | null;
  openai: TRecord | null;
  claudeSubscription: TRecord | null;
  anthropic: TRecord | null;
}> {
  return {
    openaiCodex: serviceId === 'openai-codex' ? record : null,
    openai: serviceId === 'openai' ? record : null,
    claudeSubscription: serviceId === 'claude-subscription' ? record : null,
    anthropic: serviceId === 'anthropic' ? record : null,
  };
}
