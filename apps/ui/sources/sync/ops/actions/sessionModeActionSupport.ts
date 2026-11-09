import type { ResolvedActionOption } from '@happier-dev/protocol/actions/actionCatalog';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

import {
  computeSessionModePickerControl,
  getSessionModePickerOptions,
  resolveRequestedSessionModeIdForMetadata,
  type SessionModePickerControl,
} from '@/sync/domains/sessionControl/sessionModeControl';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export function normalizeRequestedSessionModeId(
  control: SessionModePickerControl | null,
  modeId: unknown,
): string {
  const normalized = String(modeId ?? '').trim();
  return resolveRequestedSessionModeIdForMetadata(control, normalized);
}

type SessionModeActionSource = Parameters<typeof readSessionOwnerMetadataView>[0];

export function resolveSessionModeActionControl(session: SessionModeActionSource | null | undefined): SessionModePickerControl | null {
  // A Session whose Agent identity cannot be read has no mode picker; it must
  // not fall back to the default Agent's modes.
  const metadata = session ? readSessionOwnerMetadataView(session) : null;
  const agentId = resolveAgentIdFromSessionMetadata(metadata);
  if (agentId === null) return null;
  return computeSessionModePickerControl({
    agentId,
    metadata,
  });
}

export function isSessionModeActionAvailable(session: SessionModeActionSource | null | undefined): boolean {
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

  return getSessionModePickerOptions(control.options, control.agentId).map((option) => ({
    value: option.id,
    label: option.name,
    ...(typeof option.description === 'string' && option.description.trim().length > 0
      ? { description: option.description }
      : {}),
  }));
}
