import { describe, expect, it, vi } from 'vitest';
import { ApprovalRequestV1Schema, ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentExecutionFailureDetailsV1Schema, DeploymentReviewConflictFailureDetailsV1Schema, DeploymentSourceAdmissionFailureV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { DeploymentDomainFailureDetailsV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainFailureV1';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

import { presentActionFailureTechnicalDetails, presentApprovalFailureOutcome } from './approvalFailureOutcome';
import { formatApprovalStatusLabel, resolveApprovalDisplayStatus } from '@/components/approvals/approvalStatusLabel';

const response = DaemonLocalServiceLauncherStartResponseV1Schema.parse({
    protocolVersion: 1, machineId: 'machine', targetId: 'declared:lumen', status: 'failed',
    reasonCode: 'plugin_managed_service_establishment_failed',
    establishmentFailure: { cause: 'process_exited', exitCode: 1, lastStderrLine: 'Unable to bind listener' },
    snapshot: { v: 1, machineId: 'machine', updatedAt: 10, targets: [{
        id: 'declared:lumen', source: 'managed_service', machineId: 'machine', title: 'Lumen web',
        confidence: 'high', state: 'available', serviceState: 'failed', actions: ['manage'],
        sourceClass: { kind: 'managed_service', managedServiceId: 'lumen' },
        diagnostics: [{ code: 'native_service_output', severity: 'info', message: 'Unable to bind listener' }],
    }] },
});

function approval(result: unknown = response) {
    return ApprovalRequestV1Schema.parse({ v: 1, status: 'executed', createdAtMs: 1, updatedAtMs: 2,
        createdBy: { surface: 'agent', sessionId: 'session' }, requestedSurface: 'agent',
        actionId: 'localServices.launcher.start', actionArgs: { machineId: 'machine', targetId: 'declared:lumen',
            declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'Lumen web' } } },
        summary: 'Start Lumen web', decision: { kind: 'approve', decidedAtMs: 2 },
        execution: { executedAtMs: 3, ok: true, result } });
}

describe('approval failure outcome', () => {
    it('renders terminal receipt recovery without exposing its receipt coordinates', () => {
        const details = { ok: true, environmentId: 'environment-private', revision: 4,
            deploymentId: 'receipt-private', deploymentRevision: 2, state: 'outcome_unknown',
            requiredFact: 'deploymentActionResult', remedy: 'Confirm the previous deployment result before retrying.' };
        const lines = presentActionFailureTechnicalDetails({ errorCode: 'outcome_unknown', error: 'outcome_unknown', details });
        expect(lines).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'failure-required-fact', value: details.requiredFact }),
            expect.objectContaining({ key: 'failure-remedy', value: details.remedy }),
        ]));
        expect(JSON.stringify(lines)).not.toMatch(/environment-private|receipt-private/);
        expect(presentActionFailureTechnicalDetails({ errorCode: 'outcome_unknown', error: 'outcome_unknown',
            details: { ...details, credential: 'secret-must-not-render' } })).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ key: 'failure-remedy', value: details.remedy }),
            ]));
    });

    it.each(['domainIngress', 'managedServiceDocker'])('names the Domain that stopped retirement and keeps source fact %s and its remedy', requiredFact => {
        const details = { environmentId: 'environment-private', domainId: 'domain-private', domainHostname: 'tools.example.test',
            step: 'removeDomain', partial: true, requiredFact, remedy: 'Restore ingress and retry Stop and remove.' };
        expect(DeploymentDomainFailureDetailsV1Schema.parse(details)).toEqual(details);
        expect(DeploymentDomainFailureDetailsV1Schema.safeParse({ ...details, requiredFact: undefined }).success).toBe(false);
        const outcome = presentApprovalFailureOutcome(approval(), { ok: false,
            errorCode: 'deployment_domain_native_unavailable', error: 'deployment_domain_native_unavailable', details });
        expect(outcome.reason).toContain('tools.example.test');
        expect(outcome.reason).toContain(details.remedy);
        expect(outcome.technicalDetails).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'failure-required-fact', value: requiredFact }),
            expect.objectContaining({ key: 'failure-phase', value: 'removeDomain' }),
        ]));
        expect(JSON.stringify(outcome.technicalDetails)).not.toContain('-private');
        const { domainHostname: _hostname, ...unreadableDomain } = details;
        expect(DeploymentDomainFailureDetailsV1Schema.parse(unreadableDomain)).toEqual(unreadableDomain);
        expect(presentApprovalFailureOutcome(approval(), { ok: false,
            errorCode: 'deployment_content_unavailable', error: 'deployment_content_unavailable', details: unreadableDomain }).reason)
            .toBe(`${details.domainId} · ${details.remedy}`);
    });

    it('shows what remains when final Environment removal fails after native teardown', () => {
        const details = { environmentId: 'environment-private', step: 'removeEnvironment', partial: true,
            requiredFact: 'environmentRemoval', remedy: 'The Environment remains. Restore its Home connection and retry removal.' };
        const outcome = presentApprovalFailureOutcome(approval(), { ok: false,
            errorCode: 'deployment_conflict', error: 'deployment_conflict', details });
        expect(outcome.reason).toBe(details.remedy);
        expect(outcome.technicalDetails).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'failure-required-fact', value: details.requiredFact }),
            expect.objectContaining({ key: 'failure-phase', value: details.step }),
            expect.objectContaining({ key: 'failure-remedy', value: details.remedy }),
        ]));
    });

    it('uses the projected recovery as the summary when a Domain refusal has only a machine code', () => {
        const details = DeploymentDomainFailureDetailsV1Schema.parse({ environmentId: 'environment', domainId: 'domain',
            step: 'native_execution', requiredFact: 'cloudflarePreparation',
            remedy: 'Inspect the selected Cloudflare tunnel and its owned hostname routes, then review the Domain operation again.' });
        const outcome = presentApprovalFailureOutcome(approval(), { ok: false,
            errorCode: 'invalid_provider_output', error: 'invalid_provider_output', details });
        expect(outcome.reason).toBe(outcome.technicalDetails.find(line => line.key === 'failure-remedy')?.value);
        expect(outcome.reason).toBe(details.remedy);
    });

    it.each(['deployment_content_unavailable', 'deployment_unavailable', 'unsupported'])(
        'renders shared recovery for the bare %s refusal', errorCode => {
            const lines = presentActionFailureTechnicalDetails({ errorCode, error: errorCode }, 'deployment');
            expect(lines).toEqual(expect.arrayContaining([
                expect.objectContaining({ key: 'failure-required-fact', value: 'deploymentActionResult' }),
                expect.objectContaining({ key: 'failure-remedy', value: expect.stringMatching(/\S/) }),
            ]));
        });

    it('retains typed native cause, effect and recovery facts without exposing receipt identities', () => {
        const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'native_failed', error: 'native_failed',
            details: DeploymentExecutionFailureDetailsV1Schema.parse({ serverId: 'home-private', environmentId: 'environment-private',
                targetLinkId: 'target-private', deploymentId: 'receipt-private', failure: {
                    code: 'native_failed', phase: 'activate', effectAttempted: true,
                    failureCause: { phase: 'deployment.activate', errorClass: 'Error', errorCode: 'EACCES', httpStatus: 403 },
                    remedy: 'Review the deployment target and try again.',
                } }) });
        const outcome = presentApprovalFailureOutcome(approval(), failure);
        expect(outcome.technicalDetails?.map(line => line.value)).toEqual(expect.arrayContaining([
            'activate', 'deployment.activate', 'Error', 'EACCES', '403', 'true',
            'Review the deployment target and try again.',
        ]));
        expect(JSON.stringify(outcome.technicalDetails)).not.toContain('-private');
    });

    it('keeps the strongest source-admission fact and recovery rather than the generic receipt advice', () => {
        const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'deployment_source_unavailable', error: 'deployment_source_unavailable',
            details: DeploymentExecutionFailureDetailsV1Schema.parse({ serverId: 'home', environmentId: 'environment',
                targetLinkId: 'target', deploymentId: 'receipt', failure: { code: 'deployment_source_unavailable', phase: 'source',
                    effectAttempted: false, remedy: 'Generic recovery advice',
                    sourceAdmission: { phase: 'deployment_source_admission', reason: 'requester_workspace_requires_owner',
                        requiredFact: 'unrestricted_workspace_requester', remedy: 'run_from_authorized_host' } } }) });
        const values = presentApprovalFailureOutcome(approval(), failure).technicalDetails?.map(line => line.value);
        expect(values).toEqual(expect.arrayContaining(['deployment_source_admission', 'requester_workspace_requires_owner', 'false', 'unrestricted_workspace_requester', 'run_from_authorized_host']));
        expect(values).not.toContain('Generic recovery advice');
    });

    it('shows direct source-admission recovery before a deployment receipt exists', () => {
        const details = DeploymentSourceAdmissionFailureV1Schema.parse({ phase: 'deployment_source_admission',
            reason: 'requester_authority_unavailable', requiredFact: 'verified_root_requester', remedy: 'retry_original_request' });
        const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'agent_isolation_unavailable',
            error: 'agent_isolation_unavailable', effectAttempted: false, details });
        const values = presentApprovalFailureOutcome(approval(), failure).technicalDetails.map(line => line.value);
        expect(values).toEqual(expect.arrayContaining(['deployment_source_admission', 'requester_authority_unavailable',
            'false', 'verified_root_requester', 'retry_original_request']));
        expect(JSON.stringify(presentApprovalFailureOutcome(approval(), { ...failure,
            details: { ...details, credential: 'secret-must-not-render' } }).technicalDetails))
            .not.toContain('secret-must-not-render');
    });

    it('shows the conflict fact and current revision while dropping arbitrary untyped details', () => {
        const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'deployment_conflict', error: 'deployment_conflict',
            effectAttempted: false, details: DeploymentReviewConflictFailureDetailsV1Schema.parse({ serverId: 'home',
                environmentId: 'environment', targetLinkId: 'target', requiredFact: 'currentEnvironmentRevision',
                currentEnvironmentRevision: 9, remedy: 'Review the latest environment and try again.' }) });
        expect(presentApprovalFailureOutcome(approval(), failure).technicalDetails?.map(line => line.value))
            .toEqual(expect.arrayContaining(['false', 'currentEnvironmentRevision', '9', 'Review the latest environment and try again.']));
        expect(JSON.stringify(presentApprovalFailureOutcome(approval(), { ...failure,
            details: { requiredFact: 'currentEnvironmentRevision', credential: 'secret-must-not-render' } }).technicalDetails)).not.toContain('secret-must-not-render');
    });

    it('uses the native domain fact and remedy without rendering operation routing metadata', () => {
        const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'native_effect_failed', error: 'native_effect_failed',
            effectAttempted: true, details: DeploymentDomainFailureDetailsV1Schema.parse({ environmentId: 'environment-private',
                domainId: 'domain-private', step: 'native_execution', requiredFact: 'caddyListeners',
                failure: { kind: 'native_effect_failed', reason: 'port_in_use', requiredFact: 'caddyListeners', errorCode: 'EADDRINUSE', port: 443 },
                remedy: 'Free the listener port and try again.' }) });
        const lines = presentApprovalFailureOutcome(approval(), failure).technicalDetails;
        expect(lines?.map(line => line.value)).toEqual(expect.arrayContaining(['native_execution', 'true', 'caddyListeners',
            'port_in_use', 'EADDRINUSE', 'Free the listener port and try again.']));
        expect(JSON.stringify(lines)).not.toContain('-private');
    });

    it('carries the stored native start reason and output to the settled approval outcome', () => {
        const request = approval();
        const failure = readApprovalExecutionFailure(request);
        expect(failure?.errorCode).toBe(response.reasonCode);
        if (!failure) throw new Error('Missing native failure');
        const outcome = presentApprovalFailureOutcome(request, failure);
        expect(outcome.reason).toBe('Lumen web stopped before it was ready.');
        expect(outcome).toMatchObject({ code: response.reasonCode, serviceStartFailure: {
            reasonCode: response.reasonCode, serviceName: 'Lumen web', establishmentFailure: response.establishmentFailure,
            recovery: { kind: 'reviewOutput', lines: ['Unable to bind listener'] },
        } });
        expect(outcome.reason).not.toContain(response.reasonCode!);
    });

    it('retains the typed reason and last output when the post-start feed could not be read', () => {
        const request = approval({ ...response, snapshot: { ...response.snapshot, targets: [] } });
        const failure = readApprovalExecutionFailure(request);
        if (!failure) throw new Error('Missing native failure');
        expect(presentApprovalFailureOutcome(request, failure)).toMatchObject({
            reason: 'Lumen web stopped before it was ready.',
            serviceStartFailure: { serviceName: 'Lumen web', establishmentFailure: response.establishmentFailure,
                recovery: { kind: 'reviewOutput', lines: ['Unable to bind listener'] } },
        });
    });

    it('does not borrow a start failure from another Machine or a successful start', () => {
        const request = approval();
        const failure = readApprovalExecutionFailure(request);
        if (!failure) throw new Error('Missing native failure');
        for (const result of [
            { ...response, machineId: 'other', snapshot: { ...response.snapshot, machineId: 'other', targets: [] } },
            { ...response, targetId: 'other' },
            { ...response, status: 'succeeded', reasonCode: undefined, establishmentFailure: undefined },
        ]) {
            const outcome = presentApprovalFailureOutcome(approval(result), failure);
            expect(outcome).not.toHaveProperty('serviceStartFailure');
            expect(outcome.reason).toBeNull();
        }
    });
});

/** A settled confidential fill as the executor records it (QA-D26B row 4). */
function settledConfidentialFill(result: unknown) {
    return ApprovalRequestV2Schema.parse({ v: 2, status: 'executed', createdAtMs: 1, updatedAtMs: 3,
        createdBy: { surface: 'system', sessionId: 'session-1' }, requestedSurface: 'ui',
        actionId: 'browser.automation.secret.fill', summary: 'Sign in',
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
            serverId: 'server-1', serverIdentityId: 'srv_home', sessionId: 'session-1', machineId: 'machine-1',
            target: { kind: 'session', sessionId: 'session-1' }, actionId: 'browser.automation.secret.fill', requestId: 'operation-1' },
        actionArgs: { serverId: 'server-1', sessionId: 'session-1', machineId: 'machine-1', purpose: 'Sign in',
            browserSessionId: 'browser-1', viewId: 'view-1', tabId: 'tab-1', frameId: 'frame-1',
            documentId: 'document-1', navigationGeneration: 1, origin: 'https://example.com',
            field: { fieldId: 'password', focusId: 'focus-1', locator: '#password' } },
        decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' },
        execution: { executedAtMs: 3, effectAttempted: true, ok: true, result } });
}

describe('confidential fill outcome', () => {
    it('names a refused entry by what happened, not as an unexplained failed Action', () => {
        const request = settledConfidentialFill({ status: 'refused', code: 'target_changed' });
        const failure = readApprovalExecutionFailure(request);
        if (!failure) throw new Error('Missing refused fill');
        const outcome = presentApprovalFailureOutcome(request, failure);
        expect(outcome.headline).toBe('The target changed. Review it again before entering a credential.');
        expect(outcome.reason).toBe('Nothing was entered.');
    });

    it('keeps a refusal without its own detail to one sentence', () => {
        const request = settledConfidentialFill({ status: 'refused', code: 'target_unavailable' });
        const failure = readApprovalExecutionFailure(request);
        if (!failure) throw new Error('Missing refused fill');
        const outcome = presentApprovalFailureOutcome(request, failure);
        expect(outcome.headline).toBe('The credential was not entered. Review the target or Saved Secret and request entry again.');
        expect(outcome.reason).toBeNull();
    });

    it('gives the request a status that follows the recorded entry outcome', () => {
        const status = (result: unknown) => formatApprovalStatusLabel(resolveApprovalDisplayStatus(settledConfidentialFill(result)));
        expect(status({ status: 'refused', code: 'target_changed' })).toBe('Not entered');
        expect(status({ status: 'canceled', code: 'canceled' })).toBe('Canceled');
        expect(status({ status: 'unknown', code: 'delivery_unknown' })).toBe('Outcome unknown');
        expect(status({ status: 'filled', code: 'filled' })).toBe('Executed');
    });
});
