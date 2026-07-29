import type { Href } from 'expo-router';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

type RouteParamValue = string | string[] | undefined;

export const VOICE_SETTINGS_PRIVACY_FOCUS_TARGET = {
  pathname: SETTINGS_ROUTES.voice,
  params: { focus: 'privacy' },
} as const satisfies Href;

export const VOICE_SETTINGS_PROVIDER_FOCUS_TARGET = {
  pathname: SETTINGS_ROUTES.voice,
  params: { focus: 'provider' },
} as const satisfies Href;

export type VoiceSettingsRouteFocus = 'privacy' | 'provider';

export function resolveVoiceSettingsRouteFocus(
  value: RouteParamValue,
): VoiceSettingsRouteFocus | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate === 'privacy' || candidate === 'provider' ? candidate : null;
}
