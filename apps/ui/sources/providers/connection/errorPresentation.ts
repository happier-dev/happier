import {
    createProviderErrorV1,
    ProviderErrorCodeV1Schema,
    ProviderErrorV1Schema,
    type ProviderErrorCodeV1,
    type ProviderErrorV1,
    type ProviderRecoveryActionV1,
} from '@happier-dev/protocol';

import type { TranslationKeyNoParams } from '@/text';
import { canDispatchProviderRecoveryAction, type ProviderRecoveryAvailability } from './recovery';

export type ProviderErrorPresentation = Readonly<{
    titleKey: TranslationKeyNoParams;
    descriptionKey: TranslationKeyNoParams;
    action: ProviderRecoveryActionV1 | null;
    severity: 'neutral' | 'warning' | 'danger';
    context: Readonly<{
        connectionId?: string;
        machineId?: string;
        sourceProfileId?: string;
        retryAfterMs?: number;
    }>;
}>;

type ProviderErrorCopy = Pick<ProviderErrorPresentation, 'titleKey' | 'descriptionKey'>;

const PRESENTATIONS = Object.freeze({
    provider_secret_missing: {
        titleKey: 'settingsProviders.errors.secretMissingTitle',
        descriptionKey: 'settingsProviders.errors.secretMissingDescription',
    },
    provider_not_enabled_on_machine: {
        titleKey: 'settingsProviders.errors.notEnabledOnMachineTitle',
        descriptionKey: 'settingsProviders.errors.notEnabledOnMachineDescription',
    },
    provider_connection_disabled: {
        titleKey: 'settingsProviders.errors.disabledTitle',
        descriptionKey: 'settingsProviders.errors.disabledDescription',
    },
    provider_endpoint_unreachable: {
        titleKey: 'settingsProviders.errors.unreachableTitle',
        descriptionKey: 'settingsProviders.errors.unreachableDescription',
    },
    provider_connection_not_found: {
        titleKey: 'settingsProviders.errors.notFoundTitle',
        descriptionKey: 'settingsProviders.errors.notFoundDescription',
    },
    provider_connection_changed: {
        titleKey: 'settingsProviders.errors.connectionChangedTitle',
        descriptionKey: 'settingsProviders.errors.connectionChangedDescription',
    },
    provider_contribution_unavailable: {
        titleKey: 'settingsProviders.errors.sourceUnavailableTitle',
        descriptionKey: 'settingsProviders.errors.sourceUnavailableDescription',
    },
    provider_feature_disabled: {
        titleKey: 'settingsProviders.errors.featureDisabledTitle',
        descriptionKey: 'settingsProviders.errors.featureDisabledDescription',
    },
    provider_endpoint_auth_required: {
        titleKey: 'settingsProviders.errors.secretMissingTitle',
        descriptionKey: 'settingsProviders.errors.secretMissingDescription',
    },
    provider_endpoint_unauthorized: {
        titleKey: 'settingsProviders.errors.unauthorizedTitle',
        descriptionKey: 'settingsProviders.errors.unauthorizedDescription',
    },
    provider_endpoint_rate_limited: {
        titleKey: 'settingsProviders.errors.rateLimitedTitle',
        descriptionKey: 'settingsProviders.errors.rateLimitedDescription',
    },
    provider_account_grant_stale: {
        titleKey: 'settingsProviders.errors.accessChangedTitle',
        descriptionKey: 'settingsProviders.errors.accessChangedDescription',
    },
    provider_machine_grant_stale: {
        titleKey: 'settingsProviders.errors.accessChangedTitle',
        descriptionKey: 'settingsProviders.errors.accessChangedDescription',
    },
    provider_incompatible_with_agent: {
        titleKey: 'settingsProviders.errors.incompatibleTitle',
        descriptionKey: 'settingsProviders.errors.incompatibleDescription',
    },
    provider_compatibility_unverified: {
        titleKey: 'settingsProviders.errors.unverifiedTitle',
        descriptionKey: 'settingsProviders.errors.unverifiedDescription',
    },
    provider_credential_transport_unavailable: {
        titleKey: 'settingsProviders.errors.credentialUnsupportedTitle',
        descriptionKey: 'settingsProviders.errors.credentialUnsupportedDescription',
    },
    provider_endpoint_unavailable: {
        titleKey: 'settingsProviders.errors.unreachableTitle',
        descriptionKey: 'settingsProviders.errors.unreachableDescription',
    },
    provider_machine_unavailable: {
        titleKey: 'settingsProviders.errors.machineUnavailableTitle',
        descriptionKey: 'settingsProviders.errors.machineUnavailableDescription',
    },
    provider_probe_capacity_exhausted: {
        titleKey: 'settingsProviders.errors.probeCapacityTitle',
        descriptionKey: 'settingsProviders.errors.probeCapacityDescription',
    },
    provider_rpc_response_invalid: {
        titleKey: 'settingsProviders.errors.rpcResponseInvalidTitle',
        descriptionKey: 'settingsProviders.errors.rpcResponseInvalidDescription',
    },
    provider_rpc_mutation_outcome_unknown: {
        titleKey: 'settingsProviders.errors.mutationOutcomeUnknownTitle',
        descriptionKey: 'settingsProviders.errors.mutationOutcomeUnknownDescription',
    },
    provider_probe_response_invalid: {
        titleKey: 'settingsProviders.errors.connectionInvalidTitle',
        descriptionKey: 'settingsProviders.errors.connectionInvalidDescription',
    },
    provider_model_not_found: {
        titleKey: 'settingsProviders.errors.modelNotFoundTitle',
        descriptionKey: 'settingsProviders.errors.modelNotFoundDescription',
    },
    provider_model_unloaded: {
        titleKey: 'settingsProviders.errors.modelUnloadedTitle',
        descriptionKey: 'settingsProviders.errors.modelUnloadedDescription',
    },
    provider_authorization_changed: {
        titleKey: 'settingsProviders.errors.accessChangedTitle',
        descriptionKey: 'settingsProviders.errors.accessChangedDescription',
    },
    provider_binding_changed: {
        titleKey: 'settingsProviders.errors.restartRequiredTitle',
        descriptionKey: 'settingsProviders.errors.restartRequiredDescription',
    },
    provider_switch_unsupported: {
        titleKey: 'settingsProviders.errors.restartRequiredTitle',
        descriptionKey: 'settingsProviders.errors.restartRequiredDescription',
    },
    provider_agent_runtime_unsupported: {
        titleKey: 'settingsProviders.errors.connectionInvalidTitle',
        descriptionKey: 'settingsProviders.errors.connectionInvalidDescription',
    },
    provider_managed_requires_daemon: {
        titleKey: 'settingsProviders.errors.managedRequiresDaemonTitle',
        descriptionKey: 'settingsProviders.errors.managedRequiresDaemonDescription',
    },
    provider_materialization_failed: {
        titleKey: 'settingsProviders.errors.connectionInvalidTitle',
        descriptionKey: 'settingsProviders.errors.connectionInvalidDescription',
    },
    provider_probe_authorization_invalid: {
        titleKey: 'settingsProviders.errors.probeExpiredTitle',
        descriptionKey: 'settingsProviders.errors.probeExpiredDescription',
    },
    provider_settings_limit_exceeded: {
        titleKey: 'settingsProviders.errors.settingsLimitTitle',
        descriptionKey: 'settingsProviders.errors.settingsLimitDescription',
    },
    provider_settings_invalid: {
        titleKey: 'settingsProviders.errors.connectionInvalidTitle',
        descriptionKey: 'settingsProviders.errors.connectionInvalidDescription',
    },
    provider_connection_invalid: {
        titleKey: 'settingsProviders.errors.connectionInvalidTitle',
        descriptionKey: 'settingsProviders.errors.connectionInvalidDescription',
    },
    provider_profile_migration_source_changed: {
        titleKey: 'settingsProviders.errors.migrationChangedTitle',
        descriptionKey: 'settingsProviders.errors.migrationChangedDescription',
    },
    provider_profile_migration_source_not_found: {
        titleKey: 'settingsProviders.errors.migrationMissingTitle',
        descriptionKey: 'settingsProviders.errors.migrationMissingDescription',
    },
    provider_profile_migration_conflict: {
        titleKey: 'settingsProviders.errors.migrationConflictTitle',
        descriptionKey: 'settingsProviders.errors.migrationConflictDescription',
    },
} satisfies Record<ProviderErrorCodeV1, ProviderErrorCopy>);

const GENERIC: ProviderErrorPresentation = Object.freeze({
    titleKey: 'settingsProviders.errors.genericTitle',
    descriptionKey: 'settingsProviders.errors.genericDescription',
    action: null,
    severity: 'danger',
    context: {},
});

const DANGER_CODES: ReadonlySet<ProviderErrorCodeV1> = new Set([
    'provider_endpoint_unauthorized',
    'provider_probe_response_invalid',
    'provider_settings_invalid',
    'provider_connection_invalid',
    'provider_credential_transport_unavailable',
]);

const RECOVERY_ACTION_TITLE_KEYS = {
    review_features: 'settingsProviders.errors.actions.reviewFeatures',
    choose_connection: 'settingsProviders.errors.actions.chooseConnection',
    restore_plugin: 'settingsProviders.errors.actions.restorePlugin',
    enable_connection: 'settingsProviders.errors.actions.enableConnection',
    review_account_grant: 'settingsProviders.errors.actions.reviewAccountGrant',
    enable_on_machine: 'settingsProviders.errors.actions.enableOnMachine',
    review_machine_grant: 'settingsProviders.errors.actions.reviewMachineGrant',
    review_compatibility: 'settingsProviders.errors.actions.reviewCompatibility',
    add_secret: 'settingsProviders.errors.actions.addSecret',
    review_credential_transport: 'settingsProviders.errors.actions.reviewCredentialTransport',
    review_connection: 'settingsProviders.errors.actions.reviewConnection',
    retry: 'settingsProviders.errors.actions.retry',
    replace_secret: 'settingsProviders.errors.actions.replaceSecret',
    choose_model: 'settingsProviders.errors.actions.chooseModel',
    load_model: 'settingsProviders.errors.actions.loadModel',
    review_and_restart: 'settingsProviders.errors.actions.reviewAndRestart',
    restart_probe: 'settingsProviders.errors.actions.restartProbe',
    reduce_provider_settings: 'settingsProviders.errors.actions.reduceProviderSettings',
    review_profile_migration: 'settingsProviders.errors.actions.reviewProfileMigration',
    review_current_state: 'settingsProviders.errors.actions.reviewCurrentState',
} as const satisfies Record<ProviderRecoveryActionV1, TranslationKeyNoParams>;

function severityFor(error: ProviderErrorV1): ProviderErrorPresentation['severity'] {
    if (DANGER_CODES.has(error.code)) return 'danger';
    return error.retryable ? 'neutral' : 'warning';
}

export function presentProviderError(input: unknown): ProviderErrorPresentation {
    const full = ProviderErrorV1Schema.safeParse(input);
    const codeCandidate = typeof input === 'object' && input !== null && 'code' in input
        ? (input as { code?: unknown }).code
        : input;
    const code = ProviderErrorCodeV1Schema.safeParse(codeCandidate);
    let error: ProviderErrorV1;
    if (full.success) error = full.data;
    else if (code.success) error = createProviderErrorV1(code.data);
    else return GENERIC;
    const context = {
        ...(error.connectionId ? { connectionId: error.connectionId } : {}),
        ...(error.machineId ? { machineId: error.machineId } : {}),
        ...(error.sourceProfileId ? { sourceProfileId: error.sourceProfileId } : {}),
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    };
    return {
        ...PRESENTATIONS[error.code],
        action: error.action,
        severity: severityFor(error),
        context,
    };
}

export function presentProviderRecoveryAction(
    input: unknown,
    availability: ProviderRecoveryAvailability,
): Readonly<{ titleKey: TranslationKeyNoParams }> | null {
    const parsed = ProviderErrorV1Schema.safeParse(input);
    if (!parsed.success || !canDispatchProviderRecoveryAction(parsed.data, availability)) return null;
    return { titleKey: RECOVERY_ACTION_TITLE_KEYS[parsed.data.action] };
}
