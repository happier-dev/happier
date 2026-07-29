import { VoiceProviderIdSchema, type VoiceProviderId } from '@happier-dev/protocol';

import type { VoiceSessionSnapshot, VoiceSessionStatus } from './types';

export type VoiceMicButtonProjection = Readonly<{
  active: boolean;
  available: boolean;
  configured: boolean;
}>;

const PROJECTIONS = Object.freeze({
  inactiveUnavailableUnconfigured: Object.freeze({ active: false, available: false, configured: false }),
  inactiveUnavailableConfigured: Object.freeze({ active: false, available: false, configured: true }),
  inactiveAvailableUnconfigured: Object.freeze({ active: false, available: true, configured: false }),
  inactiveAvailableConfigured: Object.freeze({ active: false, available: true, configured: true }),
  activeUnconfigured: Object.freeze({ active: true, available: true, configured: false }),
  activeConfigured: Object.freeze({ active: true, available: true, configured: true }),
} satisfies Readonly<Record<string, VoiceMicButtonProjection>>);

function isVoiceSessionStatus(value: unknown): value is VoiceSessionStatus {
  return value === 'disconnected'
    || value === 'connecting'
    || value === 'connected'
    || value === 'error';
}

/**
 * Canonical shell projection for voice mic affordances. Consumers render this
 * semantic result and never reinterpret provider ids or runtime status strings.
 * Runtime-invalid values fail closed until the voice contract adopts them.
 */
export function deriveMicButtonProjection(input: Readonly<{
  selectedProviderId: VoiceProviderId | null;
  snapshot: VoiceSessionSnapshot;
}>): VoiceMicButtonProjection {
  const rawProviderId: unknown = input.selectedProviderId;
  const configured = rawProviderId !== null && VoiceProviderIdSchema.safeParse(rawProviderId).success;
  const providerIdIsValid = rawProviderId === null || configured;
  const status: unknown = input.snapshot?.status;

  if (!providerIdIsValid || !isVoiceSessionStatus(status)) {
    return configured
      ? PROJECTIONS.inactiveUnavailableConfigured
      : PROJECTIONS.inactiveUnavailableUnconfigured;
  }

  const active = status === 'connecting' || status === 'connected';
  const available = configured || input.snapshot.canStop === true;

  if (active) {
    return configured ? PROJECTIONS.activeConfigured : PROJECTIONS.activeUnconfigured;
  }
  if (available) {
    return configured
      ? PROJECTIONS.inactiveAvailableConfigured
      : PROJECTIONS.inactiveAvailableUnconfigured;
  }
  return PROJECTIONS.inactiveUnavailableUnconfigured;
}
