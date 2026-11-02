import { describe, expect, it } from 'vitest';
import { projectExecutionRunError, sanitizeExecutionRunError } from './errors';

describe('Run connected account startup failure redaction', () => {
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
});
