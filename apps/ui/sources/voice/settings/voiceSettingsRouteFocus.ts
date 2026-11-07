import type { Href } from 'expo-router';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { SETTING_ANCHOR_QUERY_PARAM } from '@/components/settings/catalog/settingDeclarations';
import { VOICE_CONVERSATIONS_SETTINGS } from './voiceSettingsDeclarations';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';

type RouteParamValue = string | string[] | undefined;

export const VOICE_SETTINGS_PRIVACY_FOCUS_TARGET = {
  pathname: SETTINGS_ROUTES.voice,
  params: { focus: 'privacy' },
} as const satisfies Href;

export const VOICE_SETTINGS_PROVIDER_FOCUS_TARGET = {
  pathname: SETTINGS_ROUTES.voiceConversations,
  params: { [SETTING_ANCHOR_QUERY_PARAM]: VOICE_CONVERSATIONS_SETTINGS.settings.provider.anchor },
} as const satisfies Href;

export const VOICE_SETTINGS_EXECUTION_MACHINE_FOCUS_TARGET = {
  pathname: SETTINGS_ROUTES.voiceConversations,
  params: { [SETTING_ANCHOR_QUERY_PARAM]: VOICE_CONVERSATIONS_SETTINGS.settings.executionMachine.anchor, focus: 'execution_machine' },
} as const satisfies Href;

export type VoiceSettingsRouteFocus = 'privacy' | 'provider' | 'execution_machine' | 'local';

export function resolveVoiceSettingsRecoveryFocus(
  action: VoiceRoleReadiness['recoveryAction'],
): Exclude<VoiceSettingsRouteFocus, 'privacy'> | null {
  if (action === 'none' || action === 'retry' || action === 'enable_voice_agent') return null;
  if (action === 'select_execution_machine') return 'execution_machine';
  if (action === 'install_model') return 'local';
  return 'provider';
}

/** The existing feature turn-on destination and section recovery share one route owner. */
export function resolveVoiceSettingsRecoveryTarget(readiness: Pick<VoiceRoleReadiness, 'status' | 'code' | 'recoveryAction'>): Href | null;
export function resolveVoiceSettingsRecoveryTarget(action: VoiceRoleReadiness['recoveryAction']): Href | null;
export function resolveVoiceSettingsRecoveryTarget(input: VoiceRoleReadiness['recoveryAction'] | Pick<VoiceRoleReadiness, 'status' | 'code' | 'recoveryAction'>): Href | null {
  // An unsettled observation has no setup destination; its owner will publish the result.
  if (typeof input !== 'string' && (input.status === 'ready'
    || (input.status === 'unavailable' && input.code.endsWith('_unknown')))) return null;
  const action = typeof input === 'string' ? input : input.recoveryAction;
  if (action === 'enable_voice_agent') return SETTINGS_ROUTES.features;
  const focus = resolveVoiceSettingsRecoveryFocus(action);
  if (focus === 'provider') return VOICE_SETTINGS_PROVIDER_FOCUS_TARGET;
  if (focus === 'execution_machine') return VOICE_SETTINGS_EXECUTION_MACHINE_FOCUS_TARGET;
  return focus ? { pathname: SETTINGS_ROUTES.voiceConversations, params: { focus } } : null;
}

export function resolveVoiceSettingsRouteFocus(
  value: RouteParamValue,
): VoiceSettingsRouteFocus | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate === 'privacy'
    || candidate === 'provider'
    || candidate === 'execution_machine'
    || candidate === 'local'
    ? candidate
    : null;
}
