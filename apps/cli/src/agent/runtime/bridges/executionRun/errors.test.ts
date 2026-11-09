import { describe, expect, it } from 'vitest';

import { projectExecutionRunError, sanitizeExecutionRunError } from './errors';
import { createCodexAppServerTurnFailure } from '@happier-dev/plugins-codex/agent/runtime/appServer/turns/failure';
import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { createRunnerDaemonPluginServicesPreparationError } from '@/daemon/agentRuntime/runnerDaemonPluginServicesHost';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

describe('Run startup failure redaction', () => {
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
            sanitizeExecutionRunError(error, () => 'Startup refused'), value => value));
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
            sanitizeExecutionRunError(failure, () => 'Startup refused'), value => value));
        expect(projected).toMatchObject({ code: 'provider_endpoint_unavailable', runtimeIssueV1: {
            code: 'provider_endpoint_unavailable', failureCause: { phase: 'client_start' },
        } });
        expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
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
            sanitizeExecutionRunError(failure, () => 'Startup refused'), value => value));
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
        const sanitized = sanitizeExecutionRunError(sanitizeExecutionRunError(failure, () => 'Startup refused'), value => value);
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
