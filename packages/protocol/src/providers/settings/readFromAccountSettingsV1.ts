import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderSettingsV1Schema,
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

export type ProviderSettingsMutationBasisV1 = Readonly<
  | { status: 'mutable'; settings: ProviderSettingsV1 }
  | { status: 'refused'; diagnostics: readonly ProviderSettingsParseDiagnosticV1[] }
>;

/**
 * The single decision for whether an Account Settings document's Provider
 * subtree may be REWRITTEN.
 *
 * `readProviderSettingsFromAccountSettingsV1` is deliberately recovering: a
 * future-version or malformed subtree still yields usable settings so readers
 * can degrade instead of failing. That recovered value is NOT a safe basis for a
 * write. Rewriting the subtree from it replaces the original bytes with
 * normalized defaults and silently erases connections, grants, endpoint
 * overrides, machine secret bindings, defaults, and visibility state that this
 * build could not parse.
 *
 * Every writer — the CLI Provider settings owner and the encrypted client CAS
 * paths alike — consumes this one decision so a Provider subtree is either
 * mutated from a fully understood basis or left byte-for-byte untouched.
 */
export function readProviderSettingsMutationBasisV1(
  raw: unknown,
): ProviderSettingsMutationBasisV1 {
  const read = readProviderSettingsFromAccountSettingsV1(raw);
  return read.diagnostics.length > 0
    ? { status: 'refused', diagnostics: read.diagnostics }
    : { status: 'mutable', settings: read.settings };
}

/**
 * Writes one Provider subtree back into an Account Settings document, in the
 * exact canonical shape every writer must produce. Only a value derived from
 * `readProviderSettingsMutationBasisV1`'s `mutable` basis belongs here.
 */
export function writeProviderSettingsToAccountSettingsV1(
  raw: Readonly<Record<string, unknown>>,
  settings: ProviderSettingsV1,
): Record<string, unknown> {
  return { ...raw, providerSettingsV1: ProviderSettingsV1Schema.parse(settings) };
}
