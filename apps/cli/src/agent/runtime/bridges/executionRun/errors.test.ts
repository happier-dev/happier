import { describe, expect, it } from 'vitest';

import { markExecutionRunStartPreparationFailure, projectExecutionRunError, sanitizeExecutionRunError } from './errors';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionOutputDiagnostic, withActionFailureCauseDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { createCodexAppServerTurnFailure } from '@happier-dev/plugins-codex/agent/runtime/appServer/turns/failure';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { createRunnerDaemonPluginServicesPreparationError } from '@/daemon/agentRuntime/runnerDaemonPluginServicesHost';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { ExecutionRunErrorSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';

describe('Run startup failure redaction', () => {
    it('preserves a closed Team credential refusal in the terminal Run without copying private details', () => {
        const code = 'session_team_credential_binding_rejected';
        const privateText = 'private source evidence';
        const failure = (reason: string) => Object.assign(new Error('Team credential binding refused'), {
            code, reason, details: { privateText },
        });
        const project = (reason: string) => projectExecutionRunError(sanitizeExecutionRunError(failure(reason), value => value));
        expect(project('team_context_required')).toEqual({
            code, message: 'Team credential binding refused', details: { reason: 'team_context_required' },
        });
        expect(project(privateText)).toEqual({ code, message: 'Team credential binding refused' });
    });

    it('redacts private evidence from a thrown structured native cause before public Run projection', () => {
        const privateText = 'private source transcript echoed by a thrown native error';
        const failure = Object.assign(new Error(privateText), { code: 'provider_failed',
            details: { failureCause: { phase: 'turn', failureReason: 'unclassified_provider_error', providerErrorMessage: privateText } },
        });
        const projected = projectExecutionRunError(sanitizeExecutionRunError(failure, text => text.replaceAll(privateText, '[redacted]')));
        expect(projected.code).toBe('provider_failed');
        expect(projected.runtimeIssueV1?.failureCause).toMatchObject({ phase: 'turn',
            failureReason: 'unclassified_provider_error', providerErrorMessage: '[redacted]' });
        expect(JSON.stringify(projected)).not.toContain(privateText);
        const privateIdentity = Object.assign(new Error(privateText), { name: privateText, code: privateText });
        expect(sanitizeExecutionRunError(privateIdentity, text => text.replaceAll(privateText, '[redacted]')))
            .toMatchObject({ name: '[redacted]', code: '[redacted]' });
        expect(projectExecutionRunError(sanitizeExecutionRunError(failure, text => text === 'turn' ? '[redacted]' : text)))
            .not.toHaveProperty('runtimeIssueV1');
    });

    it('redacts private evidence from connected account diagnostic data before public Run projection', async () => {
        const privateText = 'private source transcript echoed by credential diagnostic';
        const { buildConnectedServiceCredentialSpawnErrorResult } = await import('@/daemon/connectedServices/diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult');
        const failure = buildConnectedServiceCredentialSpawnErrorResult({ agentId: 'codex', error: {
            name: 'ConnectedServiceSpawnProfileActionRequiredError', kind: 'profile_action_required',
            action: 'reconnect_connected_service_profile', serviceId: 'happier.agent.codex/openai-codex', profileId: 'work',
        } });
        if (!failure || failure.errorDetail?.kind !== 'connected_service_ux_diagnostic') throw new Error('Expected diagnostic');
        const uxDiagnostic = { ...failure.errorDetail.uxDiagnostic, diagnostics: { providerMessage: privateText } };
        const error = Object.assign(new Error(privateText), { code: uxDiagnostic.code, uxDiagnostic });
        const projected = projectExecutionRunError(sanitizeExecutionRunError(error, text => text.replaceAll(privateText, '[redacted]')));
        expect(projected.uxDiagnostic).toMatchObject({ code: uxDiagnostic.code, diagnostics: { providerMessage: '[redacted]' } });
        expect(JSON.stringify(projected)).not.toContain(privateText);
        expect(projectExecutionRunError(sanitizeExecutionRunError(error, text => text === uxDiagnostic.code ? '[redacted]' : text)))
            .not.toHaveProperty('uxDiagnostic');
    });

    it('marks no Run creation with the preparation cause without private exception fields', () => {
        const error = Object.assign(new TypeError('PRIVATE_PREPARATION_REASON'), {
            cause: { headers: { authorization: 'PRIVATE_CREDENTIAL' }, body: 'PRIVATE_RESPONSE' },
        });
        const failure = markExecutionRunStartPreparationFailure(error, 'execution_run_profile_preparation_failed');
        expect(failure).toMatchObject({ rpcErrorCode: 'execution_run_profile_preparation_failed',
            executionRunStartPreparationReason: 'PRIVATE_PREPARATION_REASON',
            details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } });
        const diagnostic = readActionOutputDiagnostic(failure);
        expect(diagnostic?.failureCause).toEqual({ phase: 'execution.run.start', errorClass: 'TypeError',
            errorCode: 'execution_run_profile_preparation_failed', httpStatus: null });
        expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_');
    });

    it('preserves a more precise carried preparation cause', () => {
        const cause = Object.assign(new TypeError('PRIVATE_PROVIDER_RESPONSE'), { code: 'ENOENT' });
        const error = withActionFailureCauseDiagnostic(new Error('Preparation failed'), cause, 'runner.registry.acquire');
        const failure = markExecutionRunStartPreparationFailure(error, 'execution_run_contribution_snapshot_unavailable');
        expect(readActionOutputDiagnostic(failure)?.failureCause)
            .toEqual(projectActionFailureCauseV1(cause, 'runner.registry.acquire'));
        expect(JSON.stringify(readActionOutputDiagnostic(failure))).not.toContain('PRIVATE_');
    });

    it('retains the connected account diagnostic through repeated redaction and public Run projection', async () => {
        const { buildConnectedServiceCredentialSpawnErrorResult } = await import('@/daemon/connectedServices/diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult');
        const failure = buildConnectedServiceCredentialSpawnErrorResult({ agentId: 'codex', error: {
            name: 'ConnectedServiceSpawnProfileActionRequiredError', kind: 'profile_action_required',
            action: 'reconnect_connected_service_profile', serviceId: 'happier.agent.codex/openai-codex', profileId: 'work',
        } });
        if (!failure || failure.errorDetail?.kind !== 'connected_service_ux_diagnostic') throw new Error('Expected diagnostic');
        const uxDiagnostic = failure.errorDetail.uxDiagnostic;
        const error = Object.assign(new Error('PRIVATE_PROVIDER_BODY'), { code: uxDiagnostic.code, uxDiagnostic });
        const projected = projectExecutionRunError(sanitizeExecutionRunError(
            sanitizeExecutionRunError(error, text => text.replaceAll('PRIVATE_PROVIDER_BODY', 'Startup refused')), value => value));
        expect(projected).toMatchObject({ code: uxDiagnostic.code, uxDiagnostic });
        const { ExecutionRunStartFailureDetailsV1Schema, withExecutionRunStartFailureDetails } = await import('@happier-dev/protocol/execution/runs/responseSchemas');
        expect(ExecutionRunStartFailureDetailsV1Schema.parse(withExecutionRunStartFailureDetails(
            { uxDiagnostic }, 'noRunCreated'))).toMatchObject({ uxDiagnostic });
        expect(JSON.stringify(projected)).not.toContain('PRIVATE_PROVIDER_BODY');
    });
    it('keeps native authentication identity when a startup cause becomes a public issue', () => {
        const failure = createCodexAppServerTurnFailure({ phase: 'thread_open', value: { error: {
            message: 'PRIVATE_NATIVE_BODY', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
        } } });
        const projected = projectExecutionRunError(sanitizeExecutionRunError(failure, redactBugReportSensitiveText));
        expect(projected.runtimeIssueV1).toMatchObject({ code: 'provider_endpoint_auth_required', agentId: 'codex',
            source: 'auth_error', sanitizedPreview: 'Sign in to Codex or choose a Codex account.',
            failureCause: { phase: 'thread_open', httpStatus: 401 },
        });
        expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    });

    it('retains the real Codex preparation cause through repeated public Run projection', () => {
        const failure = createCodexAppServerTurnFailure({ phase: 'client_start', value:
            Object.assign(new Error('PRIVATE_PROVIDER_RESPONSE'), { code: 'provider_endpoint_unavailable' }) });
        const projected = projectExecutionRunError(sanitizeExecutionRunError(
            sanitizeExecutionRunError(failure, text => text.replaceAll('PRIVATE_PROVIDER_RESPONSE', 'Startup refused')), value => value));
        expect(projected).toMatchObject({ code: 'provider_endpoint_unavailable', runtimeIssueV1: {
            code: 'provider_endpoint_unavailable', failureCause: { phase: 'client_start' },
        } });
        expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    });

    it('publishes the Account snapshot refusal subphase through native Run redaction', () => {
        const failureCause = {
            phase: 'account_snapshot.requester_not_current', errorClass: 'Error',
            errorCode: 'provider_authorization_changed', httpStatus: null,
        } as const;
        const refusal = createProviderErrorV1(failureCause.errorCode, { failureCause });
        const sanitized = sanitizeExecutionRunError(refusal, value => value);
        const published = ExecutionRunErrorSchema.parse(projectExecutionRunError(sanitized));
        expect(published).toMatchObject({ code: failureCause.errorCode, runtimeIssueV1: {
            failureCause: { actionCause: failureCause },
        } });
    });

    it('retains the daemon preparation stage through Codex startup and public Run publication', () => {
        const preparationError = createRunnerDaemonPluginServicesPreparationError(
            Object.assign(new Error('PRIVATE_PROVIDER_RESPONSE'), {
                code: 'ENOENT', path: '/PRIVATE_SOCKET', details: { secret: 'PRIVATE_CREDENTIAL' },
            }),
            'registry_acquisition',
        );
        const failure = createCodexAppServerTurnFailure({ phase: 'client_start', value: preparationError });
        const projected = projectExecutionRunError(sanitizeExecutionRunError(
            sanitizeExecutionRunError(failure, text => text.replaceAll('PRIVATE_PROVIDER_RESPONSE', 'Startup refused')), value => value));
        expect(SessionRuntimeIssueV1Schema.parse(projected.runtimeIssueV1)).toMatchObject({
            code: 'runner_plugin_services_unavailable',
            failureCause: { phase: 'client_start', preparationCause: { code: 'ENOENT', stage: 'registry_acquisition' } },
        });
        expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    });

    it('retains only the startup code\'s closed reason across repeated redaction', () => {
        const failure = Object.assign(new Error('private credential sentinel'), {
            code: 'codex_refresh_free_auth_unsupported', reason: 'refresh_bridge_unavailable',
            details: { secret: 'private credential sentinel' },
        });
        const sanitized = sanitizeExecutionRunError(sanitizeExecutionRunError(failure,
            text => text.replaceAll('private credential sentinel', 'Startup refused')), value => value);
        expect(sanitized).toMatchObject({ code: failure.code, details: { reason: 'refresh_bridge_unavailable' } });
        expect(JSON.stringify(sanitized)).not.toContain('private credential sentinel');
        for (const unsafe of [
            { code: failure.code, reason: 'private credential sentinel' },
            { code: 'unrelated_error', reason: 'refresh_bridge_unavailable' },
        ]) {
            expect(sanitizeExecutionRunError(Object.assign(new Error('Startup refused'), unsafe), value => value))
                .not.toHaveProperty('details');
        }
    });
});
