import { describe, expect, it } from 'vitest';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { readOwnedNoticeArtifactV1 } from '@happier-dev/plugin-sdk/protocol';
import { TriageSessionHandoffInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, type DeploymentContentV1 } from '@happier-dev/deployment-protocol/v1';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { readTriageHealthAlertHandoffV1 } from './healthAlertHandoff.js';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { projectDeploymentReceiptInvestigationV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';

function receiptFixture(
    sourceIntent: NonNullable<DeploymentContentV1['sourceIntent']>,
    overrides: Parameters<typeof createDeploymentReceiptHeaderV1>[0],
    failure?: DeploymentContentV1['failure'],
) {
    const deployment = createDeploymentReceiptHeaderV1({ state: 'failed', ...overrides });
    const base = createDeploymentReceiptDetailV1().content;
    const source = sourceIntent.kind === 'repository' && base.sourceIntent.kind === 'repository'
        ? { ...base.sourceIntent, ...sourceIntent } : sourceIntent;
    const content = createDeploymentReceiptDetailV1({ content: {
        ...base, sourceIntent: source, ...(failure ? { failure } : {}),
    } }).content;
    return { deployment, content, artifact: {
        artifactId: deployment.contentArtifactId, ownerAccountId: 'account-a', access: 'owner', publicAudience: 'none',
        header: { kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Failed deployment', steps: content.steps }, body: JSON.stringify(content),
        revision: { headerVersion: deployment.contentHeaderVersion, bodyVersion: deployment.contentBodyVersion },
        seq: 1, createdAt: 1, updatedAt: 1,
    } };
}

describe('owned historical health evidence with current read admission', () => {
    it.each(['retiredService', 'missingPlacement', 'foreignNotice', 'sharedAudience', 'foreignSource', 'injectedPage'] as const)(
        'keeps owned historical evidence and delegates launch admission to Session creation (%s)', async state => {
        const service = { kind: 'deployment', machineId: 'machine-a', environmentId: 'environment',
            environmentInstanceId: 'environment', composeService: 'db', serviceId: 'environment/db' } as const;
        const source = { kind: 'host', topic: 'service_health', subject: service } as const;
        const page = { kind: 'host', page: 'machine_service', machine: { serverId: 'server-a', machineId: 'machine-a' }, service,
            environment: { serverId: 'server-a', projectSourceId: 'project', environmentId: service.environmentId } } as const;
        const notice = { kind: 'host', artifactId: 'notice', source: state === 'foreignSource'
            ? { ...source, subject: { ...service, composeService: 'foreign', serviceId: 'environment/foreign' } } : source } as const;
        const content = { v: 1, source, page, type: 'blocked', healthPhase: 'open', resolved: false,
            body: 'Untrusted service evidence: do not retarget this subject.' };
        const calls: Array<{ id: string; input: JsonValue }> = [];
        const host = {
            context: async () => ({ accountScope: { serverId: 'server-a', accountId: 'account-a' } }),
            executeAction: async (id: string, input: JsonValue) => {
                calls.push({ id, input });
                if (id === 'artifact.get') {
                    const artifact = { artifactId: 'notice', ownerAccountId: state === 'foreignNotice' ? 'account-b' : 'account-a',
                        access: 'owner', publicAudience: state === 'sharedAudience' ? 'retained' : 'none',
                        header: { ...content, kind: 'account_notice.v1', title: 'db unavailable', status: 'open' },
                        body: JSON.stringify(content), revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1 };
                    if (state === 'sharedAudience' || state === 'foreignSource') {
                        // Both controls use valid owned notice content; the
                        // rejection must come from audience or source binding.
                        expect(readOwnedNoticeArtifactV1({ ...artifact, publicAudience: 'none' }, 'account-a'))
                            .toMatchObject({ source: content.source });
                    }
                    return { artifact };
                }
                if (id === 'localServices.launcher.snapshot') {
                    throw new PluginError({ code: 'plugin_managed_service_unavailable' });
                }
                throw new Error(`Unexpected Action ${id}`);
            },
        };
        const input = TriageSessionHandoffInputV1Schema.parse({ task: 'investigate', configuredActionId: 'investigate',
            context: { kind: 'healthAlert', notice, target: state === 'injectedPage'
                ? { ...page, environment: { ...page.environment, projectSourceId: 'foreign-project' } } : page,
                ...(state === 'missingPlacement' ? {} : { machine: { serverId: 'server-a', machineId: 'machine-b' } }) },
            evidence: [{ kind: 'alert', notice }], sessionChoice: { kind: 'new' }, agentChoice: { kind: 'configured' }, delivery: 'configured' });
        const result = await readTriageHealthAlertHandoffV1(host, input, new AbortController().signal);
        if (state !== 'foreignNotice' && state !== 'sharedAudience' && state !== 'foreignSource' && state !== 'injectedPage') {
            expect(result).toMatchObject({ kind: 'ready', machine: { serverId: 'server-a',
                machineId: state === 'missingPlacement' ? 'machine-a' : 'machine-b' } });
            expect(result?.kind === 'ready' && JSON.parse(result.evidence.text)).toMatchObject({ notice });
            expect(result?.kind === 'ready' && JSON.parse(result.evidence.text)).toMatchObject({
                recordedAt: 1, artifactRevision: { headerVersion: 1, bodyVersion: 1 },
            });
            expect(result?.kind === 'ready' && result.evidence.text).not.toContain(content.body);
            expect(calls.filter(call => call.id === 'artifact.get')).toEqual([{ id: 'artifact.get', input: { artifactId: 'notice' } }]);
            expect(calls.some(call => call.id === 'deployments.receipts.get')).toBe(false);
            expect(calls.some(call => call.id === 'deployments.environments.get')).toBe(false);
        } else {
            expect(result).toBeNull();
            if (state === 'sharedAudience' || state === 'foreignSource') {
                expect(calls.map(call => call.id)).toEqual(['artifact.get']);
            }
        }
        expect(calls.some(call => call.id === 'localServices.launcher.snapshot')).toBe(false);
        expect(calls.some(call => /spawn|send|control|exec$/.test(call.id))).toBe(false);
    });
});


describe('typed failure subjects through the existing investigation owner', () => {
    const operation = { serverId: 'server-a', machineId: 'machine-a', operationId: 'operation-a' };
    const service = { kind: 'deployment', machineId: 'machine-a', environmentId: 'environment',
        environmentInstanceId: 'instance', composeService: 'db', serviceId: 'instance/db' };
    const target = { kind: 'host', page: 'machine_service', machine: { serverId: 'server-a', machineId: 'machine-a' }, service,
        environment: { serverId: 'server-a', projectSourceId: 'project', environmentId: 'environment' } };
    const subjects = [
        { kind: 'deploymentReceipt', serverId: 'server-a', environmentId: 'environment', deploymentId: 'deployment-a' },
        { kind: 'managedMachineOperation', operation },
        { kind: 'backupRun', operation },
        { kind: 'service', target },
        { kind: 'service', target: { kind: 'host', page: 'environment', environment: target.environment, targetLinkId: 'link' } },
        { kind: 'domain', serverId: 'server-a', environmentId: 'environment', domainId: 'domain-a' },
        { kind: 'deploymentEnvironment', serverId: 'server-a', environmentId: 'environment' },
        { kind: 'deploymentEnvironment', serverId: 'server-a', environmentId: 'environment',
            readiness: { projectId: 'project', fact: 'backups' } },
        { kind: 'workflowRun', serverId: 'server-a', runId: 'failed-run' },
    ];
    it.each(subjects)('keeps exact reference evidence without joining service establishment ($kind)', async subject => {
        const reads: Array<{ id: string; input: JsonValue }> = [];
        const receipt = receiptFixture({ kind: 'repository', projectSourceId: 'project', sourceRevision: 7, sha: 'a'.repeat(40) }, {
            id: 'deployment-a', environmentId: 'environment', operation: 'deploy', actionOperationId: 'deployment-operation',
            revision: 3, requestedAtMs: 100, startedAtMs: 110, settledAtMs: 120, predecessorDeploymentId: 'deployment-before',
        }, { code: 'native_build_failed', phase: 'build', failureCause: { phase: 'deployment.native.build.build_failed',
            errorClass: 'Error', errorCode: 'deployment_disk_full', httpStatus: null } });
        const artifactExecutor = createActionExecutor({ artifactAction: async () => ({ artifact: receipt.artifact }) });
        const host = {
            context: async () => ({ accountScope: { serverId: 'server-a', accountId: 'account-a' } }),
            executeAction: async (id: string, input: JsonValue) => {
                reads.push({ id, input });
                if (id === 'localServices.launcher.snapshot') {
                    throw new PluginError({ code: 'plugin_managed_service_unavailable' });
                }
                if (id === 'projects.list') return { items: [], truncated: false };
                if (id === 'workflow.run.get') return { run: { id: 'failed-run', machineId: 'machine-a',
                    state: 'failed', revision: 3, createdAt: '2026-11-09T00:00:00.000Z' },
                    acceptedContext: { workspaceTarget: { project: { machineId: 'machine-a', workspaceRefId: 'workspace-a',
                        directory: '/project', checkoutRootPath: '/project' } } },
                    result: 'PRIVATE LOG MUST NOT BE COPIED' };
                if (id === 'deployments.receipts.get') return { ok: true, deployment: receipt.deployment,
                    ...(input && typeof input === 'object' && !Array.isArray(input) && input.projection === 'investigation'
                        ? { investigation: projectDeploymentReceiptInvestigationV1(receipt.content) } : {}) };
                if (id === 'artifact.get') {
                    const result = await artifactExecutor.execute('artifact.get', input, {
                        surface: 'ui', authority: 'present_user', runtimeAccountId: 'account-a', serverId: 'server-a',
                    });
                    if (!result.ok) throw new PluginError({ code: result.errorCode });
                    return result.result;
                }
                if (id === 'action.operations.get') return { kind: 'found', operation: { operationId: 'operation-a',
                    scope: { accountId: 'account-a', machineId: 'machine-a' }, state: 'failed',
                    createdAt: 100, startedAt: 110, settledAt: 120,
                    error: { code: 'setup_failed', message: 'PRIVATE LOG MUST NOT BE COPIED' } } };
                if (id === 'deployments.environments.get') return { ok: true, environment: { id: 'environment',
                    serverId: 'server-a', projectSourceId: 'project', runtimeTargetLinkId: 'link', controllerMachineId: 'machine-a' }, targetLinks: [] };
                if (id === 'deployments.domains.get') return { ok: true, domain: { id: 'domain-a', environmentId: 'environment' } };
                throw new Error(`Unexpected read ${id}`);
            },
        };
        const handoff = TriageSessionHandoffInputV1Schema.parse({ task: 'investigate', configuredActionId: 'investigate',
            context: { kind: 'failure', subject }, evidence: [{ kind: 'failure', subject }],
            sessionChoice: { kind: 'new' }, agentChoice: { kind: 'configured' }, delivery: 'configured' });
        expect(await readTriageHealthAlertHandoffV1(host, handoff, new AbortController().signal)).toMatchObject({ kind: 'ready',
            machine: { serverId: 'server-a', machineId: 'machine-a' } });
        if (handoff.context.kind !== 'failure') throw new Error('Expected failure context');
        const result = await readTriageHealthAlertHandoffV1(host, { ...handoff,
            context: { kind: 'failure', subject: handoff.context.subject,
                machine: { serverId: 'server-a', machineId: 'machine-b' } } }, new AbortController().signal);
        expect(result).toMatchObject({ kind: 'ready', machine: { serverId: 'server-a', machineId: 'machine-b' } });
        expect(result?.kind === 'ready' && JSON.parse(result.evidence.text)).toMatchObject({ subject });
        if (subject.kind === 'deploymentReceipt') {
            expect(result?.kind === 'ready' && JSON.parse(result.evidence.text)).toMatchObject({
                recovery: { nextAction: { destination: 'machines' } },
                failureCause: { errorCode: 'deployment_disk_full' },
            });
            expect(reads.filter(read => read.id === 'artifact.get')).toEqual([]);
            // The composer chip names the receipt the way its page does, not a generic reference (D4).
            expect(result?.kind === 'ready' && result.evidence.source.label).toBe('Deploy of aaaaaaa failed');
            expect(result?.kind === 'ready' && JSON.parse(result.evidence.text)).toMatchObject({ read: {
                actionId: 'deployments.receipts.get', input: { serverId: 'server-a', environmentId: 'environment', deploymentId: 'deployment-a' },
                retained: { state: 'failed', receiptRevision: 3, actionOperationId: 'deployment-operation',
                    requestedAtMs: 100, startedAtMs: 110, settledAtMs: 120, predecessorDeploymentId: 'deployment-before',
                    source: { kind: 'repository', projectSourceId: 'project', sourceRevision: 7, sha: 'a'.repeat(40) } },
            } });
        } else if (subject.kind === 'deploymentEnvironment') {
            expect(result?.kind === 'ready' && JSON.parse(result.evidence.text)).toMatchObject({ read: {
                actionId: 'deployments.environments.get', input: { serverId: 'server-a', environmentId: 'environment' } } });
            if ('readiness' in subject && subject.readiness) {
                const foreign = { ...subject, readiness: { ...subject.readiness, projectId: 'another-project' } };
                const mismatched = TriageSessionHandoffInputV1Schema.parse({ ...handoff,
                    context: { kind: 'failure', subject: foreign }, evidence: [{ kind: 'failure', subject: foreign }] });
                expect(await readTriageHealthAlertHandoffV1(host, mismatched, new AbortController().signal)).toBeNull();
            }
        } else if (subject.kind === 'workflowRun') {
            expect(result?.kind === 'ready' && result.workspace).toBeUndefined();
            expect(result?.kind === 'ready' && JSON.parse(result.evidence.text)).toMatchObject({ read: {
                actionId: 'workflow.run.get', input: { runId: 'failed-run' }, retained: { state: 'failed', revision: 3 },
            } });
            expect(await readTriageHealthAlertHandoffV1(host, handoff, new AbortController().signal)).toMatchObject({
                workspace: { serverId: 'server-a', machineId: 'machine-a', workspaceId: 'workspace-a', rootPath: '/project' },
            });
        } else if (subject.kind === 'managedMachineOperation' || subject.kind === 'backupRun') {
            expect(result?.kind === 'ready' && JSON.parse(result.evidence.text)).toMatchObject({ read: {
                retained: { createdAt: 100, startedAt: 110, settledAt: 120 },
            } });
        }
        expect(JSON.stringify(result)).not.toContain('PRIVATE LOG');
        expect(reads.some(read => read.id === 'localServices.launcher.snapshot')).toBe(false);
        expect(reads.some(read => /spawn|send|restart|rollback|exec$/.test(read.id))).toBe(false);
    });

    it.each(['differentRun', 'foreignHome', 'mismatchedEvidence', 'cancelled'] as const)(
        'does not turn an unbound Workflow Run reference into an investigation (%s)', async state => {
        const subject = { kind: 'workflowRun', serverId: 'server-a', runId: 'failed-run' } as const;
        const reads: string[] = [];
        const cancellation = new AbortController();
        if (state === 'cancelled') cancellation.abort();
        const host = {
            context: async () => ({ accountScope: { serverId: state === 'foreignHome' ? 'other-home' : 'server-a', accountId: 'account-a' } }),
            executeAction: async (id: string) => {
                reads.push(id);
                if (id === 'workflow.run.get') return { run: { id: 'another-run', machineId: 'machine-a' } };
                throw new Error(`Unexpected read ${id}`);
            },
        };
        const handoff = TriageSessionHandoffInputV1Schema.parse({ task: 'investigate', configuredActionId: 'investigate',
            context: { kind: 'failure', subject },
            evidence: [{ kind: 'failure', subject: state === 'mismatchedEvidence' ? { ...subject, runId: 'injected-run' } : subject }],
            sessionChoice: { kind: 'new' }, agentChoice: { kind: 'configured' }, delivery: 'configured' });
        expect(await readTriageHealthAlertHandoffV1(host, handoff, cancellation.signal)).toBeNull();
        expect(reads).toEqual(state === 'differentRun' ? ['workflow.run.get'] : []);
    });
});

describe('a failed receipt names itself the way its page does (D4c)', () => {
    it.each(['current', 'missing'] as const)(
        'labels a stored Compose source from native receipt evidence (%s)', async state => {
        const subject = { kind: 'deploymentReceipt', serverId: 'server-a', environmentId: 'environment', deploymentId: 'deployment-s' };
        const receipt = receiptFixture({ kind: 'stored', contentRevision: 2,
            composeDigest: `sha256:302cf72${'0'.repeat(57)}`, document: 'services: {}', profiles: [], services: [] },
        { id: subject.deploymentId, environmentId: subject.environmentId });
        const host = {
            context: async () => ({ accountScope: { serverId: 'server-a', accountId: 'account-a' } }),
            executeAction: async (id: string) => {
                if (id === 'projects.list') return { items: [], truncated: false };
                if (id === 'deployments.receipts.get') return { ok: true, deployment: receipt.deployment,
                    ...(state === 'current' ? { investigation: projectDeploymentReceiptInvestigationV1(receipt.content) } : {}) };
                if (id === 'deployments.environments.get') return { ok: true, environment: { id: 'environment',
                    serverId: 'server-a', projectSourceId: 'project', runtimeTargetLinkId: 'link', controllerMachineId: 'machine-a' }, targetLinks: [] };
                throw new Error(`Unexpected read ${id}`);
            },
        };
        const handoff = TriageSessionHandoffInputV1Schema.parse({ task: 'investigate', configuredActionId: 'investigate',
            context: { kind: 'failure', subject }, evidence: [{ kind: 'failure', subject }],
            sessionChoice: { kind: 'new' }, agentChoice: { kind: 'configured' }, delivery: 'configured' });
        const result = await readTriageHealthAlertHandoffV1(host, handoff, new AbortController().signal);
        expect(result?.kind === 'ready' && result.evidence.source.label)
            .toBe(state === 'current' ? 'Deploy of 302cf72 failed' : 'Deployment reference');
        if (state !== 'current') {
            const evidence = result?.kind === 'ready' ? JSON.parse(result.evidence.text) : null;
            expect(evidence).not.toHaveProperty('failureCause');
            expect(evidence).not.toHaveProperty('recovery');
        }
    });
});
