import { create } from 'zustand';

import {
  areSessionAddressesEqual,
  normalizeSessionAddress,
  sessionAddressKey,
  type SessionAddress,
} from '@/sync/domains/session/sessionAddress';

export type VoiceAssistantScope = 'session' | 'global';

export type VoiceIdleTarget =
  | Readonly<{ kind: 'global' }>
  | Readonly<{ kind: 'session'; sessionAddress: SessionAddress | null }>;
export type VoiceStartIntent = VoiceIdleTarget | Readonly<{ kind: 'default' }>;

/** One idle policy for shell, shortcut and glance. Explicit composer/Home intents stay explicit. */
export function resolveVoiceIdleTarget(input: Readonly<{
  intent: VoiceStartIntent;
  scopeDefault: VoiceAssistantScope;
  allowsGlobalStart: boolean;
  focusedSessionAddress: SessionAddress | null;
  lastFocusedSessionAddress: SessionAddress | null;
}>): VoiceIdleTarget {
  if (input.intent.kind === 'global') return input.intent;
  if (input.intent.kind === 'session') return { kind: 'session', sessionAddress: normalizeAddress(input.intent.sessionAddress) };
  if (input.scopeDefault === 'global' && input.allowsGlobalStart) return { kind: 'global' };
  return { kind: 'session', sessionAddress: normalizeAddress(input.focusedSessionAddress) ?? normalizeAddress(input.lastFocusedSessionAddress) };
}

export type VoiceTargetState = Readonly<{
  scope: VoiceAssistantScope;
  primaryActionSessionAddress: SessionAddress | null;
  voiceLiveContextSessionAddresses: ReadonlyArray<SessionAddress>;
  lastFocusedSessionAddress: SessionAddress | null;
  setScope: (scope: VoiceAssistantScope) => void;
  setPrimaryActionSessionAddress: (address: SessionAddress | null) => void;
  setVoiceLiveContextSessionAddresses: (addresses: ReadonlyArray<SessionAddress>) => void;
  addVoiceLiveContextSessionAddress: (address: SessionAddress) => void;
  removeVoiceLiveContextSessionAddress: (address: SessionAddress) => void;
  setLastFocusedSessionAddress: (address: SessionAddress | null) => void;
}>;

function normalizeAddress(value: SessionAddress | null | undefined): SessionAddress | null {
  return value ? normalizeSessionAddress(value.serverId, value.sessionId) : null;
}

/**
 * Resolves the one action target shared by Voice tools and presentation.
 * Session-scoped Voice is bound to its admitted Session and must never fall
 * through to a retained global target.
 */
export function resolveVoiceActionTargetAddress(input: Readonly<{
  scope: VoiceAssistantScope;
  currentSessionAddress?: SessionAddress | null;
  primaryActionSessionAddress?: SessionAddress | null;
  lastFocusedSessionAddress?: SessionAddress | null;
}>): SessionAddress | null {
  const currentSessionAddress = normalizeAddress(input.currentSessionAddress);
  if (currentSessionAddress) return currentSessionAddress;
  if (input.scope !== 'global') return null;
  return normalizeAddress(input.primaryActionSessionAddress)
    ?? normalizeAddress(input.lastFocusedSessionAddress);
}

function normalizeVoiceLiveContextSessionAddresses(
  values: ReadonlyArray<SessionAddress> | null | undefined,
): ReadonlyArray<SessionAddress> {
  if (!Array.isArray(values)) return [];
  const out = new Map<string, SessionAddress>();
  for (const raw of values) {
    const address = normalizeAddress(raw);
    if (!address) continue;
    out.set(sessionAddressKey(address), address);
  }
  return [...out.values()].sort((left, right) => sessionAddressKey(left).localeCompare(sessionAddressKey(right)));
}

export const useVoiceTargetStore = create<VoiceTargetState>((set) => ({
  scope: 'global',
  primaryActionSessionAddress: null,
  voiceLiveContextSessionAddresses: [],
  lastFocusedSessionAddress: null,
  setScope: (scope) => set((state) => state.scope === scope ? state : { scope }),
  setPrimaryActionSessionAddress: (address) =>
    set((state) => {
      const primaryActionSessionAddress = normalizeAddress(address);
      return areSessionAddressesEqual(state.primaryActionSessionAddress, primaryActionSessionAddress)
        ? state
        : { primaryActionSessionAddress };
    }),
  setVoiceLiveContextSessionAddresses: (addresses) =>
    set(() => ({ voiceLiveContextSessionAddresses: normalizeVoiceLiveContextSessionAddresses(addresses) })),
  addVoiceLiveContextSessionAddress: (address) =>
    set((state) => ({
      voiceLiveContextSessionAddresses: normalizeVoiceLiveContextSessionAddresses([
        ...state.voiceLiveContextSessionAddresses,
        address,
      ]),
    })),
  removeVoiceLiveContextSessionAddress: (address) =>
    set((state) => {
      const normalized = normalizeAddress(address);
      if (!normalized) return state;
      return {
        voiceLiveContextSessionAddresses: state.voiceLiveContextSessionAddresses.filter(
          (candidate) => !areSessionAddressesEqual(candidate, normalized),
        ),
      };
    }),
  setLastFocusedSessionAddress: (address) =>
    set((state) => {
      const lastFocusedSessionAddress = normalizeAddress(address);
      return areSessionAddressesEqual(state.lastFocusedSessionAddress, lastFocusedSessionAddress)
        ? state
        : { lastFocusedSessionAddress };
    }),
}));
