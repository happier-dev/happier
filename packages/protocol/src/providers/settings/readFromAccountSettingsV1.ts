import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  parseProviderSettingsV1Narrow,
  type ProviderSettingsParseDiagnosticV1,
  type ProviderSettingsV1,
} from './v1.js';
import { classifyProviderSettingsSubtreeV1 } from './classifySubtreeV1.js';

export type ProviderSettingsReadResultV1 = Readonly<{
  settings: ProviderSettingsV1;
  diagnostics: readonly ProviderSettingsParseDiagnosticV1[];
}>;

export function readProviderSettingsFromAccountSettingsV1(raw: unknown): ProviderSettingsReadResultV1 {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      settings: DEFAULT_PROVIDER_SETTINGS_V1,
      diagnostics: [{ path: 'providerSettingsV1', reason: 'invalid_account_settings' }],
    };
  }
  const classification = classifyProviderSettingsSubtreeV1(raw);
  if (classification.kind === 'absent') return { settings: DEFAULT_PROVIDER_SETTINGS_V1, diagnostics: [] };
  if (classification.kind === 'current') {
    return parseProviderSettingsV1Narrow(classification.settings);
  }
  if (classification.kind === 'future') {
    return {
      settings: DEFAULT_PROVIDER_SETTINGS_V1,
      diagnostics: [{ path: 'providerSettingsV1', reason: 'unsupported_future_version' }],
    };
  }
  const providerSettings = (raw as Record<string, unknown>).providerSettingsV1;
  if (!providerSettings || typeof providerSettings !== 'object' || Array.isArray(providerSettings)) {
    return {
      settings: DEFAULT_PROVIDER_SETTINGS_V1,
      diagnostics: [{ path: 'providerSettingsV1', reason: 'invalid_record' }],
    };
  }
  const recovered = parseProviderSettingsV1Narrow(providerSettings);
  return {
    settings: recovered.settings,
    diagnostics: recovered.diagnostics.length > 0
      ? recovered.diagnostics
      : [{ path: 'providerSettingsV1', reason: 'invalid_record' }],
  };
}
