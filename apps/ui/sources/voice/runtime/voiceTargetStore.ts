import { create } from 'zustand';
import { accountSettingsScopeKeySuffix, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import type { DesktopAppWindowSurface } from '@/desktop/window/appWindowSurface';

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
  restartTarget?: VoiceIdleTarget | null;
  focusedWindowSurface?: Pick<DesktopAppWindowSurface, 'homeId' | 'accountId' | 'sessionId'> | null;
  currentAccountId?: string | null;
}>): VoiceIdleTarget {
  if (input.intent.kind === 'global') return input.intent;
  if (input.intent.kind === 'session') return { kind: 'session', sessionAddress: normalizeAddress(input.intent.sessionAddress) };
  if (input.restartTarget) return input.restartTarget;
  if (input.scopeDefault === 'global' && input.allowsGlobalStart) return { kind: 'global' };
  if (input.focusedWindowSurface) {
    const surface = input.focusedWindowSurface;
    // The existing Voice intent carries a Home-qualified Session, within the executing Account.
    // A different Account never falls through to a colliding Session in the primary renderer.
    return { kind: 'session', sessionAddress: surface.accountId === input.currentAccountId
      ? normalizeSessionAddress(surface.homeId, surface.sessionId) : null };
  }
  return { kind: 'session', sessionAddress: normalizeAddress(input.focusedSessionAddress) ?? normalizeAddress(input.lastFocusedSessionAddress) };
}

export type VoiceTargetState = Readonly<{
  autoTargetMachineByScope: Readonly<Record<string, string | null>>;
  rememberAutoTargetMachine: (scope: AccountSettingsScope, machineId: string | null) => void;
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
  current: ReadonlyArray<SessionAddress>,
): ReadonlyArray<SessionAddress> {
  if (!Array.isArray(values)) return current.length === 0 ? current : [];
  const currentByKey = new Map(current.map((address) => [sessionAddressKey(address), address]));
  const out = new Map<string, SessionAddress>();
  for (const raw of values) {
    const address = normalizeAddress(raw);
    if (!address) continue;
    const key = sessionAddressKey(address);
    out.set(key, currentByKey.get(key) ?? address);
  }
  const next = [...out.values()].sort((left, right) => sessionAddressKey(left).localeCompare(sessionAddressKey(right)));
  return next.length === current.length && next.every((address, index) => address === current[index]) ? current : next;
}

export const useVoiceTargetStore = create<VoiceTargetState>((set) => ({
  scope: 'global',
  primaryActionSessionAddress: null,
  voiceLiveContextSessionAddresses: [],
  lastFocusedSessionAddress: null,
  autoTargetMachineByScope: {},
  rememberAutoTargetMachine: (scope, machineId) => set((state) => {
    const key = accountSettingsScopeKeySuffix(scope);
    const normalized = normalizeNonEmptyString(machineId);
    return Object.hasOwn(state.autoTargetMachineByScope, key) && state.autoTargetMachineByScope[key] === normalized
      ? state
      : { autoTargetMachineByScope: { ...state.autoTargetMachineByScope, [key]: normalized } };
  }),
  setScope: (scope) => set((state) => state.scope === scope ? state : { scope }),
  setPrimaryActionSessionAddress: (address) =>
    set((state) => {
      const primaryActionSessionAddress = normalizeAddress(address);
      return state.primaryActionSessionAddress === primaryActionSessionAddress
        || areSessionAddressesEqual(state.primaryActionSessionAddress, primaryActionSessionAddress)
        ? state
        : { primaryActionSessionAddress };
    }),
  setVoiceLiveContextSessionAddresses: (addresses) =>
    set((state) => {
      const voiceLiveContextSessionAddresses = normalizeVoiceLiveContextSessionAddresses(addresses, state.voiceLiveContextSessionAddresses);
      return voiceLiveContextSessionAddresses === state.voiceLiveContextSessionAddresses ? state : { voiceLiveContextSessionAddresses };
    }),
  addVoiceLiveContextSessionAddress: (address) =>
    set((state) => {
      const normalized = normalizeAddress(address);
      if (!normalized || state.voiceLiveContextSessionAddresses.some((candidate) => areSessionAddressesEqual(candidate, normalized))) return state;
      return { voiceLiveContextSessionAddresses: normalizeVoiceLiveContextSessionAddresses([
        ...state.voiceLiveContextSessionAddresses,
        normalized,
      ], state.voiceLiveContextSessionAddresses) };
    }),
  removeVoiceLiveContextSessionAddress: (address) =>
    set((state) => {
      const normalized = normalizeAddress(address);
      if (!normalized) return state;
      const voiceLiveContextSessionAddresses = state.voiceLiveContextSessionAddresses.filter(
        (candidate) => !areSessionAddressesEqual(candidate, normalized),
      );
      return voiceLiveContextSessionAddresses.length === state.voiceLiveContextSessionAddresses.length
        ? state : { voiceLiveContextSessionAddresses };
    }),
  setLastFocusedSessionAddress: (address) =>
    set((state) => {
      const lastFocusedSessionAddress = normalizeAddress(address);
      return state.lastFocusedSessionAddress === lastFocusedSessionAddress
        || areSessionAddressesEqual(state.lastFocusedSessionAddress, lastFocusedSessionAddress)
        ? state
        : { lastFocusedSessionAddress };
    }),
}));
