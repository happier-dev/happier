import { describe, expect, it } from 'vitest';
import { DeploymentFailureRecoveryV1Schema, projectDeploymentFailureRecoveryV1, readDeploymentFailureRecoveryV1, readDeploymentRefusalRecoveryV1 } from './deploymentFailureRecoveryV1.js';
import { DeploymentReceiptFailureV1Schema } from './deploymentReceiptEventsV1.js';
import { DeploymentDomainFailureDetailsV1Schema } from './deploymentDomainFailureV1.js';

// These codes reach people through Deploy, Domain review, and Store preparation.
const reachableFailures = [
    ['deployment_source_unavailable', 'source'],
    ['required_fact_unavailable', 'history'],
    ['template_domain_route_required', 'domains'],
    ['template_domain_required', 'domains'],
    ['template_domain_unknown', 'domains'],
    ['unsupported_domain', 'domains'],
    ['native_route_unavailable', 'domains'],
    ['port_in_use', 'domains'],
    ['deployment_conflict', 'review'],
    ['deployment_access_denied', 'permissions'],
    ['machine_unavailable', 'machines'],
    ['secret_missing', 'variables'],
    ['template_source_unavailable', 'store'],
    ['template_changed', 'store'],
    ['deployment_failed', 'logs'],
    ['outcome_unknown', 'history'],
    ['unsupported_action', 'settings'],
    ['native_effect_failed', 'domains'],
    ['private_scope_unenforceable', 'domains'],
    ['unsupported', 'settings'],
    ['deployment_unavailable', 'history'],
    ['deployment_content_unavailable', 'source'],
    ['deployment_invalid', 'review'],
    ['deployment_teardown_required', 'settings'],
    ['deployment_in_progress', 'history'],
    ['deployment_executor_unavailable', 'machines'],
    ['deployment_target_role_unavailable', 'settings'],
    ['deployment_generation_required', 'source'],
    ['deployment_image_unavailable', 'logs'],
    ['deployment_activation_not_observed', 'logs'],
    ['deployment_log_unavailable', 'machines'],
    ['deployment_read_failed', 'machines'],
    ['deployment_source_data_kept', 'settings'],
    ['repository_required', 'source'],
    ['needs_repository', 'source'],
    ['source_access_denied', 'source'],
    ['source_changed', 'source'],
    ['source_identity_mismatch', 'source'],
    ['target_mismatch', 'settings'],
    ['target_unavailable', 'settings'],
    ['client_required', 'machines'],
    ['home_unreachable', 'machines'],
    ['host_retired', 'machines'],
    ['action_account_scope_changed', 'review'],
    ['server_scope_mismatch', 'review'],
    ['notice_account_scope_mismatch', 'review'],
    ['action_forbidden', 'permissions'],
    ['action_not_allowed', 'permissions'],
    ['credential_scope_denied', 'connectedAccounts'],
    ['connected_account_required', 'connectedAccounts'],
    ['unsupported_credential_role', 'connectedAccounts'],
    ['admin_access_unavailable', 'machines'],
    ['machine_admin_access_required', 'machines'],
    ['machine_network_review_required', 'machines'],
    ['agent_isolation_unavailable', 'machines'],
    ['approval_stale', 'review'],
    ['changed_since_review', 'review'],
    ['stale_input', 'review'],
    ['action_interactive_review_required', 'review'],
    ['approvals_not_supported', 'review'],
    ['admission_unavailable', 'machines'],
    ['service_admission_unavailable', 'machines'],
    ['authority_changed', 'permissions'],
    ['deployment_child_binding_mismatch', 'review'],
    ['deployment_child_custody_missing', 'source'],
    ['filesystem_transfer_custody_required', 'source'],
    ['cancelled', 'history'],
    ['rollback_image_unavailable', 'history'],
    ['backup_required', 'settings'],
    ['backup_failed', 'settings'],
    ['backup_integrity_failed', 'settings'],
    ['restore_prepare_required', 'settings'],
    ['restore_failed', 'history'],
    ['active_backup_automation', 'settings'],
    ['active_backup_configuration', 'settings'],
    ['invalid_backup_configuration', 'settings'],
    ['repository_locked', 'settings'],
    ['repository_password_incorrect', 'settings'],
    ['secret_binding_required', 'variables'],
    ['personal_secret_requires_promotion', 'variables'],
    ['reference_unavailable', 'variables'],
    ['template_variable_required', 'variables'],
    ['template_secret_reference_required', 'variables'],
    ['template_binding_unknown', 'variables'],
    ['template_binding_conflict', 'variables'],
    ['template_generator_undeclared', 'store'],
    ['template_needs_review', 'store'],
    ['template_resource_conflict', 'source'],
    ['template_service_conflict', 'source'],
    ['provider_scope_already_linked', 'settings'],
    ['provider_response_invalid', 'connectedAccounts'],
    ['provider_unavailable', 'connectedAccounts'],
    ['plugin_exec_system_tool_unavailable', 'machines'],
    ['plugin_exec_executable_denied', 'machines'],
    ['native_service_control_unconfirmed', 'machines'],
    ['native_failed', 'logs'],
    ['service_unavailable', 'machines'],
    ['service_operation_unavailable', 'machines'],
    ['operation_unavailable', 'history'],
    ['action_operation_unavailable', 'history'],
    ['volume_observation_unavailable', 'machines'],
    ['volume_removal_failed', 'settings'],
    ['invalid_parameters', 'review'],
    ['invalid_action_output', 'history'],
    ['invalid_action_transport_output', 'history'],
    ['invalid_destination_config', 'settings'],
    ['destination_changed', 'settings'],
    ['environment_mismatch', 'review'],
    ['health_check_subject_unavailable', 'settings'],
    ['project_defaults_unavailable', 'source'],
    ['project_defaults_content_unavailable', 'source'],
    ['project_defaults_conflict', 'review'],
    ['project_defaults_scope_mismatch', 'source'],
    ['account_settings_unavailable', 'machines'],
    ['registry_config_cleanup_failed', 'machines'],
    ['requester_authority_unavailable', 'review'],
    ['session_requester_unavailable', 'review'],
    ['requester_workspace_requires_owner', 'source'],
    ['endpoint_unavailable', 'machines'],
    ['invalid_request', 'review'],
    ['invalid_response', 'history'],
    ['invalid_value', 'review'],
    ['not_found', 'review'],
    ['outside_root', 'source'],
    ['unavailable', 'history'],
    ['request_headers_too_large', 'history'],
    ['auth_failed', 'connectedAccounts'],
] as const;

describe('deployment failure recovery', () => {
    it.each(reachableFailures)('gives %s its own remedy and an existing recovery destination', (code, destination) => {
        const recovery = readDeploymentFailureRecoveryV1(code);
        expect(recovery.remedy).not.toBe(readDeploymentFailureRecoveryV1('future_failure').remedy);
        expect(recovery).toHaveProperty('nextAction', { kind: 'navigate', destination, label: expect.any(String) });
    });

    it('does not collapse unrelated failures into the same remedy or next action', () => {
        const recoveries = reachableFailures.map(([code]) => readDeploymentFailureRecoveryV1(code));
        expect(new Set(recoveries.map(recovery => recovery.remedy)).size).toBe(reachableFailures.length);
        expect(new Set(recoveries.map(recovery => JSON.stringify(recovery.nextAction))).size).toBe(reachableFailures.length);
    });

    it('reads the originating receipt code through a generic deployment failure without exposing opaque details', () => {
        const receipt = DeploymentReceiptFailureV1Schema.parse({ code: 'deployment_source_unavailable', phase: 'source' });
        expect(readDeploymentFailureRecoveryV1('deployment_failed', { failure: receipt, providerPayload: 'private-sentinel' }))
            .toEqual(readDeploymentFailureRecoveryV1(receipt.code));
    });

    it('replaces previously saved generic recovery with the code-specific remedy', () => {
        const legacy = { requiredFact: 'deploymentActionResult', remedy: 'Inspect the reported deployment phase and current target state. Restore the missing prerequisite or choose a supported target action, then retry the original request after confirming whether the previous change took effect.' };
        expect(readDeploymentFailureRecoveryV1('deployment_source_unavailable', legacy))
            .toEqual(readDeploymentFailureRecoveryV1('deployment_source_unavailable'));
        expect(readDeploymentFailureRecoveryV1('deployment_failed', { failure: { code: 'deployment_source_unavailable', ...legacy } }))
            .toEqual(readDeploymentFailureRecoveryV1('deployment_source_unavailable'));
    });

    it('opens the Domain route for a missing route rather than retrying the mutation', () => {
        const details = { requiredFact: 'domain_ingress_required' };
        expect(readDeploymentFailureRecoveryV1('required_fact_unavailable', details)).toMatchObject({
            requiredFact: details.requiredFact, nextAction: { kind: 'navigate', destination: 'domains' },
        });
        expect(readDeploymentFailureRecoveryV1('required_fact_unavailable', details).remedy)
            .not.toBe(readDeploymentFailureRecoveryV1('required_fact_unavailable').remedy);
    });

    it.each([
        ['cloudflare_selection_required', 'domains'], ['domain_ingress_required', 'domains'],
        ['activeDomainMembers', 'settings'], ['memberCaddyObservation', 'machines'],
        ['publicCaddyObservation', 'machines'], ['edgeCaddyMachine', 'domains'],
        ['privateCaddyListener', 'domains'], ['publicCaddyListener', 'domains'],
        ['sharedTunnelOrigin', 'domains'], ['cloudflarePreparation', 'domains'],
        ['networkExposure', 'domains'], ['reachabilityPosture', 'domains'], ['domainIngress', 'domains'],
        ['managedServiceDocker', 'machines'], ['nativeContainerIdentity', 'history'],
        ['nativeServiceReplicas', 'logs'], ['routeUpstreams', 'domains'],
        ['caddyContainer', 'machines'], ['caddyMountedSeed', 'machines'], ['caddyAdminSocket', 'machines'],
        ['caddyAdminConfig', 'domains'], ['caddyPublishedBindings', 'domains'],
        ['caddyListeners', 'machines'], ['caddyRoutedNetworks', 'machines'],
    ])('uses the missing %s fact to open its existing repair surface', (requiredFact, destination) => {
        const result = readDeploymentFailureRecoveryV1('required_fact_unavailable', { requiredFact });
        expect(result.requiredFact).toBe(requiredFact);
        expect(result.remedy).not.toBe(readDeploymentFailureRecoveryV1('required_fact_unavailable').remedy);
        expect(result.nextAction).toMatchObject({ kind: 'navigate', destination });
    });

    it('reads a direct receipt code beneath a generic settlement failure', () => {
        const receipt = DeploymentReceiptFailureV1Schema.parse({ code: 'deployment_source_unavailable', phase: 'source' });
        expect(readDeploymentFailureRecoveryV1('deployment_failed', receipt)).toEqual(readDeploymentFailureRecoveryV1(receipt.code));
    });

    it('turns saved source-admission instructions into a remedy with source navigation', () => {
        const result = readDeploymentFailureRecoveryV1('deployment_failed', { failure: {
            code: 'admission_unavailable', sourceAdmission: { reason: 'requester_workspace_requires_owner',
                requiredFact: 'unrestricted_workspace_requester', remedy: 'run_from_authorized_host' },
        } });
        expect(result).toMatchObject({ requiredFact: 'unrestricted_workspace_requester',
            nextAction: { kind: 'navigate', destination: 'source' } });
        expect(result.remedy).not.toBe('run_from_authorized_host');
    });

    it('uses the native port conflict beneath a generic Domain failure', () => {
        const details = DeploymentDomainFailureDetailsV1Schema.parse({ environmentId: 'environment', domainId: 'domain',
            step: 'native_execution', failure: { kind: 'native_observation_unavailable', reason: 'port_in_use',
                requiredFact: 'caddyPublishedBindings', port: 80 } });
        expect(readDeploymentFailureRecoveryV1('required_fact_unavailable', details)).toMatchObject({
            requiredFact: 'caddyPublishedBindings', nextAction: { kind: 'navigate', destination: 'domains' },
            remedy: readDeploymentFailureRecoveryV1('port_in_use').remedy,
        });
    });

    it('preserves specific authored recovery and keeps navigation out of stored schemas', () => {
        const authored = { requiredFact: 'routeUpstreams', remedy: 'Choose the web service on port 3000.' };
        expect(readDeploymentFailureRecoveryV1('required_fact_unavailable', authored)).toMatchObject(authored);
        const stored = DeploymentFailureRecoveryV1Schema.parse(projectDeploymentFailureRecoveryV1({}));
        expect(stored).not.toHaveProperty('nextAction');
        expect(DeploymentReceiptFailureV1Schema.parse(projectDeploymentFailureRecoveryV1({
            code: 'deployment_source_unavailable', phase: 'source',
        }))).not.toHaveProperty('nextAction');
    });

    it.each([undefined, null, [], 'opaque', { providerPayload: 'private-sentinel' }])('keeps a safe unknown-code fallback for %j', details => {
        const projected = readDeploymentFailureRecoveryV1('future_failure', details);
        expect(projected).toEqual(readDeploymentFailureRecoveryV1('future_failure'));
        expect(projected.nextAction).toMatchObject({ kind: 'navigate', destination: 'history' });
    });
});

describe('deployment refusal recovery (a refused press: banner and platform sheet)', () => {
    it('names the Source remedy and its route for a missing repository or source, even when the stored remedy is the generic fallback', () => {
        const stored = projectDeploymentFailureRecoveryV1({});
        for (const code of ['deployment_source_unavailable', 'repository_required'] as const) {
            const recovery = readDeploymentRefusalRecoveryV1(code, stored);
            expect(recovery?.nextAction).toMatchObject({ kind: 'navigate', destination: 'source' });
            expect(recovery?.remedy).not.toBe(stored.remedy);
            expect(recovery).toEqual(readDeploymentFailureRecoveryV1(code, stored));
        }
    });

    it('has nothing to say for a code it does not know, so the caller keeps its own sentence', () => {
        expect(readDeploymentRefusalRecoveryV1('some_unknown_refusal')).toBeNull();
    });
});

describe('an unconfirmed receipt with a typed cause', () => {
    it('remedies the recorded cause, not the generic lost confirmation, and stays generic without one', () => {
        const failure = { code: 'outcome_unknown', phase: 'activate', failureCause: {
            phase: 'deployment.transition', errorCode: 'database_transaction_conflict_exhausted', httpStatus: 503 } };
        const caused = readDeploymentRefusalRecoveryV1('outcome_unknown', failure);
        expect(caused).not.toBeNull();
        expect(caused!.remedy).not.toBe(readDeploymentFailureRecoveryV1('outcome_unknown').remedy);
        expect(readDeploymentRefusalRecoveryV1('database_transaction_conflict_exhausted')).toEqual(caused);
        expect(readDeploymentRefusalRecoveryV1('outcome_unknown', { code: 'outcome_unknown', phase: 'activate' }))
            .toEqual(readDeploymentFailureRecoveryV1('outcome_unknown'));
    });
});
