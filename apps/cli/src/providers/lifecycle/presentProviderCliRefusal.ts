import {
  type ProviderErrorCodeV1,
  type ProviderErrorV1,
  type ProviderRecoveryActionV1,
} from '@happier-dev/protocol';

const ERROR_SUMMARIES = {
  provider_feature_disabled: 'Provider features are unavailable.',
  provider_connection_not_found: 'The Provider connection was not found.',
  provider_connection_changed: 'The Provider connection changed during the request.',
  provider_contribution_unavailable: 'The Provider plugin is unavailable.',
  provider_connection_disabled: 'The Provider connection is disabled.',
  provider_account_grant_stale: 'The Provider account access grant changed.',
  provider_not_enabled_on_machine: 'The Provider is not enabled on this machine.',
  provider_machine_grant_stale: 'The Provider machine access grant changed.',
  provider_incompatible_with_agent: 'The Provider is incompatible with this Agent.',
  provider_compatibility_unverified: 'Provider compatibility has not been confirmed.',
  provider_secret_missing: 'The Provider credential is missing.',
  provider_credential_transport_unavailable: 'The Provider credential format is unsupported.',
  provider_endpoint_unreachable: 'The Provider endpoint is unreachable.',
  provider_endpoint_unavailable: 'The Provider endpoint is unavailable.',
  // Host-side probe admission was full, so no endpoint request was attempted. Naming the
  // endpoint here would send users to check a healthy service (see ERROR_DEFAULTS in
  // packages/protocol/src/providers/errors.ts).
  provider_probe_capacity_exhausted: 'Happier could not start another Provider check on this machine yet.',
  provider_rpc_response_invalid: 'The Provider response could not be read.',
  provider_rpc_mutation_outcome_unknown: 'The selected machine may have applied the Provider change, but Happier could not confirm the result.',
  provider_endpoint_rate_limited: 'The Provider endpoint is rate limited.',
  provider_endpoint_auth_required: 'The Provider endpoint requires a credential.',
  provider_endpoint_unauthorized: 'The Provider rejected the credential.',
  provider_probe_response_invalid: 'The Provider returned an invalid catalog response.',
  provider_model_not_found: 'The Provider model was not found.',
  provider_model_unloaded: 'The Provider model is not loaded.',
  provider_authorization_changed: 'Provider authorization changed during the request.',
  provider_binding_changed: 'The persisted Provider binding no longer matches.',
  provider_switch_unsupported: 'The running session cannot switch Provider bindings.',
  provider_agent_runtime_unsupported: 'The Agent runtime cannot use this Provider binding.',
  provider_materialization_failed: 'The Provider runtime configuration could not be prepared.',
  provider_probe_authorization_invalid: 'The Provider test authorization expired.',
  provider_settings_limit_exceeded: 'The Provider settings limit was exceeded.',
  provider_settings_invalid: 'The Provider settings are invalid.',
  provider_connection_invalid: 'The Provider connection is invalid.',
  provider_profile_migration_source_changed: 'The source profile changed during Provider migration.',
  provider_profile_migration_source_not_found: 'The source profile was not found for Provider migration.',
  provider_profile_migration_conflict: 'The Provider profile migration conflicts with current settings.',
} as const satisfies Record<ProviderErrorCodeV1, string>;

const RECOVERY_GUIDANCE = {
  review_features: 'Review Provider availability and try again.',
  choose_connection: 'Choose an available Provider connection.',
  restore_plugin: 'Restore or re-enable the Provider plugin.',
  enable_connection: 'Enable the Provider connection and try again.',
  review_account_grant: 'Review the Provider account access grant.',
  enable_on_machine: 'Enable the Provider on the target machine.',
  review_machine_grant: 'Review the Provider machine access grant.',
  review_compatibility: 'Review and confirm Provider compatibility.',
  add_secret: 'Add a Saved Secret to the Provider connection.',
  review_credential_transport: 'Review the Provider credential format.',
  review_connection: 'Review the Provider connection and try again.',
  retry: 'Reload current Provider state and try again.',
  replace_secret: 'Replace the Saved Secret and try again.',
  choose_model: 'Choose an available Provider model.',
  load_model: 'Load the Provider model and try again.',
  review_and_restart: 'Review the Provider connection and restart the session.',
  restart_probe: 'Test the Provider connection again.',
  reduce_provider_settings: 'Remove unused Provider settings and try again.',
  review_profile_migration: 'Review the Provider profile migration before trying again.',
  review_current_state: 'Review current Provider state before making another change.',
} as const satisfies Record<ProviderRecoveryActionV1, string>;

const MAX_PRESENTATION_LINE_LENGTH = 512;
const TERMINAL_UNSAFE_CHARACTER = /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u;

function presentTerminalUnsafeCharacter(character: string): string {
  const codePoint = character.codePointAt(0)!;
  const codePointHex = codePoint.toString(16);
  return codePoint <= 0xffff
    ? `\\u${codePointHex.padStart(4, '0')}`
    : `\\u{${codePointHex}}`;
}

function presentBoundedCliContext(label: string, value: string): string {
  const prefix = `${label}: `;
  const maxValueLength = MAX_PRESENTATION_LINE_LENGTH - prefix.length;
  let visibleValue = '';
  const characters = value[Symbol.iterator]();
  let currentCharacter = characters.next();

  while (!currentCharacter.done) {
    const nextCharacter = characters.next();
    const character = currentCharacter.value;
    const renderedCharacter = TERMINAL_UNSAFE_CHARACTER.test(character)
      ? presentTerminalUnsafeCharacter(character)
      : character;
    const availableValueLength = maxValueLength - (nextCharacter.done ? 0 : 1);
    if (visibleValue.length + renderedCharacter.length > availableValueLength) {
      return `${prefix}${visibleValue}…`;
    }
    visibleValue += renderedCharacter;
    currentCharacter = nextCharacter;
  }

  return `${prefix}${visibleValue}`;
}

/**
 * Materializes a bounded human refusal from the closed Provider error contract.
 * It never accepts transport prose or arbitrary payload fields.
 */
export function presentProviderCliRefusal(error: ProviderErrorV1): readonly string[] {
  return Object.freeze([
    `${ERROR_SUMMARIES[error.code]} (${error.code})`,
    RECOVERY_GUIDANCE[error.action],
    ...(error.connectionId ? [presentBoundedCliContext('Connection', error.connectionId)] : []),
    ...(error.machineId ? [presentBoundedCliContext('Machine', error.machineId)] : []),
    ...(error.sourceProfileId ? [presentBoundedCliContext('Source profile', error.sourceProfileId)] : []),
    ...(error.retryAfterMs !== undefined ? [`Retry after: ${error.retryAfterMs} ms`] : []),
  ]);
}
