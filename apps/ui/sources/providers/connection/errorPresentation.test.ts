import { describe, expect, it } from 'vitest';
import { createProviderErrorV1, ProviderErrorCodeV1Schema } from '@happier-dev/protocol';

import { presentProviderError, presentProviderRecoveryAction } from './errorPresentation';

describe('provider error presentation', () => {
    it('maps stable provider errors to actionable translation keys', () => {
        expect(presentProviderError('provider_secret_missing')).toEqual(expect.objectContaining({
            titleKey: 'settingsProviders.errors.secretMissingTitle',
            descriptionKey: 'settingsProviders.errors.secretMissingDescription',
            action: 'add_secret',
        }));
        expect(presentProviderError('provider_not_enabled_on_machine').descriptionKey)
            .toBe('settingsProviders.errors.notEnabledOnMachineDescription');
        expect(presentProviderError('provider_contribution_unavailable').titleKey)
            .toBe('settingsProviders.errors.sourceUnavailableTitle');
    });

    it('presents unsupported Agent runtimes through the existing review-connection recovery copy', () => {
        expect(presentProviderError('provider_agent_runtime_unsupported')).toEqual(expect.objectContaining({
            titleKey: 'settingsProviders.errors.connectionInvalidTitle',
            descriptionKey: 'settingsProviders.errors.connectionInvalidDescription',
            action: 'review_connection',
        }));
    });

    it('presents materialization failures as connection review rather than restart continuity', () => {
        expect(presentProviderError('provider_materialization_failed')).toEqual(expect.objectContaining({
            titleKey: 'settingsProviders.errors.connectionInvalidTitle',
            descriptionKey: 'settingsProviders.errors.connectionInvalidDescription',
            action: 'review_connection',
        }));
    });

    it('presents connection revision conflicts as reload-and-review rather than access loss', () => {
        expect(presentProviderError('provider_connection_changed')).toEqual(expect.objectContaining({
            titleKey: 'settingsProviders.errors.connectionChangedTitle',
            descriptionKey: 'settingsProviders.errors.connectionChangedDescription',
            action: 'review_connection',
            severity: 'neutral',
        }));
    });

    it('presents an invalid RPC response as a contract failure rather than an unreachable Provider endpoint', () => {
        const presentation = presentProviderError(createProviderErrorV1('provider_rpc_response_invalid'));

        expect(presentation).toEqual(expect.objectContaining({
            titleKey: 'settingsProviders.errors.rpcResponseInvalidTitle',
            descriptionKey: 'settingsProviders.errors.rpcResponseInvalidDescription',
            action: 'retry',
            severity: 'neutral',
        }));
        expect(presentation.titleKey).not.toBe('settingsProviders.errors.unreachableTitle');
        expect(presentation.descriptionKey).not.toBe('settingsProviders.errors.unreachableDescription');
    });

    it('presents an unknown mutation outcome as review-only rather than replayable', () => {
        const presentation = presentProviderError(createProviderErrorV1('provider_rpc_mutation_outcome_unknown', {
            connectionId: 'pc_work',
            machineId: 'machine-a',
        }));

        expect(presentation).toEqual(expect.objectContaining({
            titleKey: 'settingsProviders.errors.mutationOutcomeUnknownTitle',
            descriptionKey: 'settingsProviders.errors.mutationOutcomeUnknownDescription',
            action: 'review_current_state',
            severity: 'warning',
            context: { connectionId: 'pc_work', machineId: 'machine-a' },
        }));
    });

    it('does not expose unknown transport or daemon prose', () => {
        expect(presentProviderError('secret=do-not-render')).toEqual(expect.objectContaining({
            titleKey: 'settingsProviders.errors.genericTitle',
            descriptionKey: 'settingsProviders.errors.genericDescription',
            action: null,
        }));
    });

    it('preserves typed recovery context without exposing arbitrary payload fields', () => {
        expect(presentProviderError(createProviderErrorV1('provider_machine_grant_stale', {
            connectionId: 'pc_work',
            machineId: 'machine-a',
        }))).toEqual(expect.objectContaining({
            severity: 'warning',
            action: 'review_machine_grant',
            context: { connectionId: 'pc_work', machineId: 'machine-a' },
        }));
    });

    it('uses danger severity for credential and invalid-connection failures', () => {
        expect(presentProviderError(createProviderErrorV1('provider_endpoint_unauthorized')).severity).toBe('danger');
        expect(presentProviderError(createProviderErrorV1('provider_connection_invalid')).severity).toBe('danger');
    });

    it('has an explicit presentation for every stable provider error code', () => {
        for (const code of ProviderErrorCodeV1Schema.options) {
            expect(presentProviderError(code), code).not.toEqual({
                titleKey: 'settingsProviders.errors.genericTitle',
                descriptionKey: 'settingsProviders.errors.genericDescription',
                action: null,
            });
        }
    });

    it.each([
        ['provider_feature_disabled', {}, {}, 'settingsProviders.errors.actions.reviewFeatures'],
        ['provider_connection_not_found', {}, {}, 'settingsProviders.errors.actions.chooseConnection'],
        ['provider_contribution_unavailable', {}, {}, 'settingsProviders.errors.actions.restorePlugin'],
        ['provider_connection_disabled', { connectionId: 'pc_a' }, {}, 'settingsProviders.errors.actions.enableConnection'],
        ['provider_account_grant_stale', { connectionId: 'pc_a' }, {}, 'settingsProviders.errors.actions.reviewAccountGrant'],
        ['provider_not_enabled_on_machine', { connectionId: 'pc_a' }, {}, 'settingsProviders.errors.actions.enableOnMachine'],
        ['provider_machine_grant_stale', { connectionId: 'pc_a' }, {}, 'settingsProviders.errors.actions.reviewMachineGrant'],
        ['provider_compatibility_unverified', { connectionId: 'pc_a' }, {}, 'settingsProviders.errors.actions.reviewCompatibility'],
        ['provider_secret_missing', { connectionId: 'pc_a' }, {}, 'settingsProviders.errors.actions.addSecret'],
        ['provider_credential_transport_unavailable', { connectionId: 'pc_a' }, {}, 'settingsProviders.errors.actions.reviewCredentialTransport'],
        ['provider_probe_response_invalid', { connectionId: 'pc_a' }, {}, 'settingsProviders.errors.actions.reviewConnection'],
        ['provider_endpoint_unreachable', {}, { retry: true }, 'settingsProviders.errors.actions.retry'],
        ['provider_endpoint_unauthorized', { connectionId: 'pc_a' }, {}, 'settingsProviders.errors.actions.replaceSecret'],
        ['provider_model_not_found', { connectionId: 'pc_a' }, {}, 'settingsProviders.errors.actions.chooseModel'],
        ['provider_model_unloaded', { connectionId: 'pc_a', modelLoadAvailable: true }, { loadModel: true }, 'settingsProviders.errors.actions.loadModel'],
        ['provider_binding_changed', {}, { reviewAndRestart: true }, 'settingsProviders.errors.actions.reviewAndRestart'],
        ['provider_probe_authorization_invalid', {}, { retry: true }, 'settingsProviders.errors.actions.restartProbe'],
        ['provider_settings_limit_exceeded', {}, {}, 'settingsProviders.errors.actions.reduceProviderSettings'],
        ['provider_profile_migration_source_changed', { sourceProfileId: 'profile-a' }, {}, 'settingsProviders.errors.actions.reviewProfileMigration'],
        ['provider_rpc_mutation_outcome_unknown', { connectionId: 'pc_a' }, {}, 'settingsProviders.errors.actions.reviewCurrentState'],
    ] as const)('presents exact actionable copy for %s', (code, context, availability, expectedTitleKey) => {
        expect(presentProviderRecoveryAction(createProviderErrorV1(code, context), availability)).toEqual({
            titleKey: expectedTitleKey,
        });
    });

    it('does not present an action that would no-op without its required context or callback', () => {
        expect(presentProviderRecoveryAction(createProviderErrorV1('provider_secret_missing'), {})).toBeNull();
        expect(presentProviderRecoveryAction(createProviderErrorV1('provider_endpoint_unreachable'), {})).toBeNull();
        expect(presentProviderRecoveryAction(createProviderErrorV1('provider_binding_changed'), {})).toBeNull();
        expect(presentProviderRecoveryAction(createProviderErrorV1('provider_profile_migration_source_changed'), {})).toBeNull();
    });
});
