import type { ResolvedActionOption } from '@happier-dev/protocol';
import { DEFAULT_AGENT_ID, resolveAgentIdFromFlavor } from '@happier-dev/agents';

import { computeSessionModePickerControl, type SessionModePickerControl } from '@/sync/acp/sessionModeControl';
import { t } from '@/text';

export function normalizeRequestedSessionModeId(modeId: unknown): string {
  const normalized = String(modeId ?? '').trim();
  return normalized === 'default' ? '' : normalized;
}

export function resolveSessionModeActionControl(session: Readonly<{ metadata?: unknown }> | null | undefined): SessionModePickerControl | null {
  const agentId = resolveAgentIdFromFlavor((session as any)?.metadata?.flavor) ?? DEFAULT_AGENT_ID;
  return computeSessionModePickerControl({
    agentId,
    metadata: ((session as any)?.metadata ?? null) as any,
  });
}

export function isSessionModeActionAvailable(session: Readonly<{ metadata?: unknown }> | null | undefined): boolean {
  return resolveSessionModeActionControl(session) !== null;
}

export function isRequestedSessionModeSupported(
  control: SessionModePickerControl | null,
  modeId: unknown,
): boolean {
  if (!control) return false;
  const normalizedModeId = normalizeRequestedSessionModeId(modeId);
  if (!normalizedModeId) return true;
  return control.options.some((option) => option.id === normalizedModeId);
}

export function serializeSessionModeActionOptions(
  control: SessionModePickerControl | null,
): readonly ResolvedActionOption[] {
  if (!control) return [];

  const options: ResolvedActionOption[] = control.options.map((option) => ({
    value: option.id,
    label: option.name,
    ...(typeof option.description === 'string' && option.description.trim().length > 0
      ? { description: option.description }
      : {}),
  }));

  if (options.some((option) => option.value === 'default')) {
    return options;
  }

  return [
    {
      value: 'default',
      label: t('common.default'),
    },
    ...options,
  ];
}
