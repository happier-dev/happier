import type { ResolvedActionOption } from '@happier-dev/protocol';
import { DEFAULT_AGENT_ID, resolveAgentIdFromFlavor } from '@happier-dev/agents';

import {
  computeSessionModePickerControl,
  getSessionModePickerOptions,
  resolveRequestedSessionModeIdForMetadata,
  type SessionModePickerControl,
} from '@/sync/domains/sessionControl/sessionModeControl';
import { readNonBlankSessionControlIdentifier } from '@/sync/domains/sessionControl/opaqueIdentifiers';

export function normalizeRequestedSessionModeId(
  control: SessionModePickerControl | null,
  modeId: unknown,
): string {
  const normalized = readNonBlankSessionControlIdentifier(modeId) ?? '';
  return resolveRequestedSessionModeIdForMetadata(control, normalized);
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
  const requestedModeId = readNonBlankSessionControlIdentifier(modeId) ?? '';
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

  return getSessionModePickerOptions(control.options, control.agentId).map((option) => ({
    value: option.id,
    label: option.name,
    ...(typeof option.description === 'string' && option.description.trim().length > 0
      ? { description: option.description }
      : {}),
  }));
}
