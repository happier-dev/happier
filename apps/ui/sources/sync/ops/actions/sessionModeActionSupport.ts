import type { ResolvedActionOption } from '@happier-dev/protocol';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

import {
  computeSessionModePickerControl,
  resolveRequestedSessionModeIdForMetadata,
  type SessionModePickerControl,
} from '@/sync/domains/sessionControl/sessionModeControl';
import { t } from '@/text';

export function normalizeRequestedSessionModeId(
  control: SessionModePickerControl | null,
  modeId: unknown,
): string {
  const normalized = String(modeId ?? '').trim();
  return resolveRequestedSessionModeIdForMetadata(control, normalized);
}

export function resolveSessionModeActionControl(session: Readonly<{ metadata?: unknown }> | null | undefined): SessionModePickerControl | null {
  // A Session whose Agent identity cannot be read has no mode picker; it must
  // not fall back to the default Agent's modes.
  const agentId = resolveAgentIdFromSessionMetadata((session as any)?.metadata);
  if (agentId === null) return null;
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
  const requestedModeId = String(modeId ?? '').trim();
  const normalizedModeId = normalizeRequestedSessionModeId(control, requestedModeId);
  if (requestedModeId === 'default') {
    return normalizedModeId === '' || normalizedModeId === 'default';
  }
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
