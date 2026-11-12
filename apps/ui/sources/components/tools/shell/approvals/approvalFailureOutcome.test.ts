import { describe, expect, it, vi } from 'vitest';
import { buildDiscussionRequesterApprovalArtifact } from '@/sync/domains/artifacts/approvalArtifacts.discussionRequester.testkit';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { t } from '@/text';
import { ApprovalRequestV1Schema, ApprovalRequestV2Schema, StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { projectApprovalExecutionFailureV2, readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { ActionExecuteFailureSchema, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentExecutionFailureDetailsV1Schema, DeploymentReviewConflictFailureDetailsV1Schema, DeploymentSourceAdmissionFailureV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { DeploymentDomainFailureDetailsV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainFailureV1';
import { DeploymentTemplateInstantiationPartialV1Schema } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

import { presentActionFailureOutcome, presentActionFailureTechnicalDetails, presentApprovalFailureOutcome } from './approvalFailureOutcome';
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
    it('directs an unconfirmed Doc suggestion back to its thread while retaining diagnostic evidence', () => {
        const artifact = buildDiscussionRequesterApprovalArtifact({ requesterAccountId: 'alice', actionId: 'doc.edit.propose',
            settle: request => ({ ...request, status: 'outcome_unknown', updatedAtMs: 30,
                decision: { kind: 'approve', decidedAtMs: 20 },
                execution: { executedAtMs: 30, ok: false, effectAttempted: true,
                    errorCode: 'approval_execution_outcome_unknown', error: 'Publication acknowledgement was lost' } }) });
        const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header!, artifact.body!);
        if (parsed?.family !== 'built_in') throw new Error('Expected built-in approval');
        const failure = readApprovalExecutionFailure(parsed.request);
        if (!failure) throw new Error('Expected recorded failure');
        const outcome = presentApprovalFailureOutcome(parsed.request, failure);
        expect(outcome.reason).toBe(t('artifacts.browser.proposal.publicationUnknown'));
        expect(outcome.code).toBe('approval_execution_outcome_unknown');
        expect(outcome.message).toBe('Publication acknowledgement was lost');
    });
    it('presents typed command evidence without disclosing opaque command or environment data', () => {
        const failure = { errorCode: 'machine_setup_setup_failed', error: 'machine_setup_setup_failed',
            details: { kind: 'finiteCommand', phase: 'setup', step: 1, exitCode: 23, signal: 0 } };
        const outcome = presentActionFailureOutcome(failure);
        expect(outcome.reason).toBe(t('localServices.actions.failure.exitCode', { code: '23' }));
        expect(outcome.technicalDetails).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'failure-phase', value: 'setup' }),
            expect.objectContaining({ key: 'failure-step', value: '2' }),
            expect.objectContaining({ key: 'failure-native-exit-code', value: '23' }),
        ]));
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'machines.setup.apply', summary: 'Apply setup',
            actionArgs: { homeId: 'home', machineId: 'machine', targets: [{ homeId: 'home', machineId: 'machine',
                desiredRevision: 0, recipePlans: [], sources: [{ kind: 'direct', setup: {} }] }] },
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
                serverId: 'home', accountId: 'account', machineId: 'machine', actionId: 'machines.setup.apply', requestId: 'setup-request' } });
        const stored = StoredApprovalRequestSchema.parse({ ...request, status: 'failed', updatedAtMs: 3,
            decision: { kind: 'approve', decidedAtMs: 2 },
            execution: projectApprovalExecutionFailureV2({ request, failure: { ok: false, ...failure }, executedAtMs: 3 }) });
        expect(presentApprovalFailureOutcome(stored, readApprovalExecutionFailure(stored)!).technicalDetails)
            .toContainEqual(expect.objectContaining({ key: 'failure-request-id', value: 'setup-request' }));
        const opaque = presentActionFailureOutcome({ ...failure, details: { ...failure.details,
            body: 'PRIVATE_COMMAND', env: { SECRET: 'PRIVATE_ENV' }, stdout: 'PRIVATE_OUTPUT' } });
        expect(JSON.stringify(opaque)).not.toMatch(/PRIVATE_/);
        expect(opaque.technicalDetails).not.toContainEqual(expect.objectContaining({ key: 'failure-step' }));
    });
    it.each([undefined, { exitCode: 1, stderr: 'Fatal: could not find snapshot [REDACTED]', stderrTruncated: true }])('retains the backup stream step and native evidence in direct and recorded failure Details: %j', nativeFailure => {
        const code = nativeFailure ? 'backup_failed' : 'outcome_unknown';
        const phase = nativeFailure ? 'deployment.backup.native' : 'dispatch';
        const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: code, error: code,
            details: { requiredFact: 'deploymentActionResult', step: nativeFailure ? 'tree' : 'backupStdin', code,
                ...(nativeFailure ? { nativeFailure } : {}) },
            failureCause: projectActionFailureCauseV1({ code }, phase) });
        const authored = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId: 'deployments.backups.run', summary: 'Back up now',
            actionArgs: { serverId: 'home', environmentId: 'environment', machineId: 'machine', installationId: 'installation',
                targetLinkId: 'target', deploymentId: 'deployment', expectedRevision: 1, configRevision: 1 },
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
                serverId: 'home', accountId: 'account', machineId: 'machine', actionId: 'deployments.backups.run', requestId: 'request' } });
        const settle = (refusal: typeof failure) => StoredApprovalRequestSchema.parse({ ...authored, status: 'failed', updatedAtMs: 3,
            decision: { kind: 'approve', decidedAtMs: 2 },
            execution: projectApprovalExecutionFailureV2({ request: authored, failure: refusal, executedAtMs: 3 }) });
        const request = settle(failure);
        const recorded = readApprovalExecutionFailure(request);
        expect(recorded).not.toBeNull();
        for (const outcome of [presentActionFailureOutcome(failure, 'deployment'), presentApprovalFailureOutcome(request, recorded!)]) {
            expect(outcome.technicalDetails).toContainEqual(expect.objectContaining({ key: 'failure-phase', value: nativeFailure ? 'tree' : 'backupStdin' }));
            expect(outcome.technicalDetails).toContainEqual(expect.objectContaining({ key: 'failure-cause-phase', value: phase }));
            if (nativeFailure) expect(outcome.technicalDetails).toEqual(expect.arrayContaining([
                expect.objectContaining({ key: 'failure-native-exit-code', value: '1' }),
                expect.objectContaining({ key: 'failure-native-stderr', value: nativeFailure.stderr }),
                expect.objectContaining({ key: 'failure-native-stderr-truncated', value: 'true' }),
            ]));
        }
        const untyped = presentActionFailureOutcome({ ...failure, details: { step: 'private-untyped-data' } }, 'deployment');
        expect(JSON.stringify(untyped.technicalDetails)).not.toContain('private-untyped-data');
        expect(settle({ ...failure, details: { ...failure.details as object, code: 'unrelated_failure' } }).execution).not.toHaveProperty('details');
        expect(settle({ ...failure, details: { ...failure.details as object, token: 'private-token' } }).execution).not.toHaveProperty('details');
        if (nativeFailure) expect(settle({ ...failure, details: { ...failure.details as object,
            nativeFailure: { ...nativeFailure, argv: 'private-native-argv' } } }).execution).not.toHaveProperty('details');
    });

    it('presents a retained Store Domain cause like the direct Add Domain failure', () => {
        const domain = DeploymentDomainFailureDetailsV1Schema.parse({ environmentId: 'environment-private', domainId: 'domain-private',
            step: 'native_execution', requiredFact: 'caddyAdminConfig',
            remedy: 'Caddy cannot bind a public port. Use Tunnel ingress or stop the other proxy, then retry.',
            failure: { kind: 'native_effect_failed', reason: 'native_effect_failed', requiredFact: 'caddyAdminConfig',
                stepId: 'caddy-container-start', nativeCommand: { command: 'docker', phase: 'start', exitCode: 1 },
                containerExitCode: 128, containerError: 'port_in_use' } });
        const partial = DeploymentTemplateInstantiationPartialV1Schema.parse({ kind: 'partial', phase: 'domains',
            errorCode: 'native_effect_failed', environmentId: 'environment-private', savedSecrets: [], failure: domain,
            requiredFact: 'deploymentActionResult', remedy: 'The machine could not apply the address change.' });
        const failure = { errorCode: 'native_effect_failed', error: 'native_effect_failed' };
        const direct = presentActionFailureOutcome({ ...failure, details: domain }, 'deployment');
        const store = presentActionFailureOutcome({ ...failure, details: partial }, 'deployment');
        expect(store.reason).toBe(direct.reason);
        expect(store.technicalDetails).toContainEqual(expect.objectContaining({ key: 'failure-required-fact', value: 'caddyAdminConfig' }));
        expect(JSON.stringify(store.technicalDetails)).not.toMatch(/environment-private|domain-private/);
    });

    it('retains a document proposal posting refusal as readable cause and typed technical detail', () => {
        const errorCode = 'discussion_post_denied';
        const request = ApprovalRequestV1Schema.parse({ ...approval(), status: 'failed', actionId: 'doc.edit.propose',
            execution: { executedAtMs: 3, ok: false, errorCode, error: errorCode } });
        const failure = readApprovalExecutionFailure(request);
        expect(failure).not.toBeNull();
        const outcome = presentApprovalFailureOutcome(request, failure!);
        expect(outcome.reason).toBe(t('session.collaboration.discussion.postDenied'));
        expect(outcome.code).toBe(errorCode);
        expect(outcome.technicalDetails).toContainEqual(expect.objectContaining({ key: 'failure-code', value: errorCode }));
    });

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

    it.each(['deployment_content_unavailable', 'deployment_unavailable', 'unsupported', 'deployment_in_progress'])(
        'renders shared recovery for the bare %s refusal', async errorCode => {
            const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
            const remedy = readDeploymentRefusalRecoveryV1(errorCode)!.remedy;
            expect(presentActionFailureOutcome({ errorCode, error: errorCode }, 'deployment').reason).toBe(remedy);
            const lines = presentActionFailureTechnicalDetails({ errorCode, error: errorCode }, 'deployment');
            expect(lines).toEqual(expect.arrayContaining([
                expect.objectContaining({ key: 'failure-required-fact', value: 'deploymentActionResult' }),
                expect.objectContaining({ key: 'failure-remedy', value: remedy }),
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

describe('deploy refused for missing required secrets', () => {
    it('names the secrets without values as the reason, and only for the typed deployment refusal', () => {
        const failure = { ok: false as const, errorCode: 'secret_missing', error: 'secret_missing',
            details: { deployable: false, missingRequiredSecretNames: ['DATABASE_URL', 'STRIPE_KEY'] } };
        const reason = presentActionFailureOutcome(failure, 'deployment').reason;
        expect(reason).toContain('DATABASE_URL');
        expect(reason).toContain('STRIPE_KEY');
        expect(presentActionFailureOutcome({ ...failure, details: { names: ['DATABASE_URL'] } }, 'deployment').reason ?? '')
            .not.toContain('DATABASE_URL');
    });
});
