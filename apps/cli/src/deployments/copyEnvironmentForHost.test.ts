import { describe, expect, it } from 'vitest';
import { DeploymentEnvironmentCreateInputV1Schema, DeploymentTemplateInstantiationPartialV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createEnvironmentWithCopyForHost } from './copyEnvironmentForHost';

describe('Copy acknowledged step result', () => {
    it.each(['linkRefused', 'pending', 'created', 'outcomeUnknown', 'failedWithoutEffectEvidence', 'failedBeforeEffect', 'noChild'] as const)('creates managed data with fresh Action custody and retains %s outcomes', async outcome => {
        const base = createDeploymentEnvironmentDetailV1();
        const principal = { kind: 'account', accountId: 'owner',
            purpose: { consumer: { pluginId: 'com.example.data', localId: 'provision' }, purpose: 'manage' },
            target: { kind: 'account', account: { service: { pluginId: 'com.example.data', localId: 'account' }, accountId: 'new-account' } } };
        const provision = { action: { pluginId: 'com.example.data', localId: 'provision' }, input: {
            v: 1, serverId: 'home', credentialRef: principal.target.account, credentialPrincipal: principal,
            providerAccountId: 'new-provider-account', providerEnvironment: { kind: 'custom', id: 'new' }, name: 'empty-copy',
        } };
        const data = ['source-data', ...(outcome === 'pending' ? ['later-data'] : [])].map(targetLinkId => ({
            targetLinkId, targetId: 'database', targetKind: 'database',
            contribution: { pluginId: 'com.example.data', localId: 'database' }, provision,
        }));
        const input = DeploymentEnvironmentCreateInputV1Schema.parse({ serverId: 'home', projectSourceId: 'destination',
            requestKey: 'copy', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: 'controller', contentArtifactId: base.environment.contentArtifactId,
            contentHeaderVersion: base.environment.contentHeaderVersion, contentBodyVersion: base.environment.contentBodyVersion,
            ...(outcome === 'created' ? { firstTargetLink: { contentArtifactId: 'runtime-content', contentHeaderVersion: 1,
                contentBodyVersion: 1, machines: [{ machineId: 'controller', installationId: 'controller-installation' }] } } : {}),
            copyIntentCommitment: 'A'.repeat(43), copyFrom: { environmentId: 'source', expectedRevision: 7,
                choices: { secrets: [], values: [], data: data.map(row => ({ targetLinkId: row.targetLinkId,
                    kind: 'createEmpty', provision: row.provision })) } }, copyPlan: { bindings: [], data } });
        const invoked: { action: unknown; input: unknown }[] = [];
        const identity = { providerAccountId: 'new-provider-account', providerResourceId: 'created', providerEnvironment: 'new' };
        const environment = { kind: 'custom', id: 'new' };
        const refusal = { ok: false as const, errorCode: 'action_forbidden', error: 'action_forbidden',
            requestId: 'copy-data-refusal', details: { requiredFact: 'verification_purpose', remedy: 'Retry the admitted link Action' },
            failureCause: { phase: 'deployments.targets.link', errorClass: 'Error' as const, errorCode: 'action_forbidden', httpStatus: 403 } };
        const context: ActionExecutorContext = { hostReviewedChild: { async invoke(request) {
            invoked.push(request);
            if (typeof request.action === 'object' && outcome === 'failedWithoutEffectEvidence') return refusal;
            if (typeof request.action === 'object' && outcome === 'failedBeforeEffect') return { ...refusal, effectAttempted: false };
            if (typeof request.action === 'object') return { ok: true, result: outcome === 'outcomeUnknown'
                ? { status: 'outcome_unknown' } : { ...(outcome === 'created' ? { state: 'provisioned' } : { status: 'provisioned' }),
                    providerIdentity: identity, providerEnvironment: environment,
                    connectionSave: { connections: { DATABASE_URL: { ref: 'happier:shared-secret:v1:created', resourceRevision: 2 } } } } };
            if (outcome === 'created') return { ok: true, result: { ok: true, environmentId: base.environment.id,
                revision: 2, targetLinkId: 'created-data', targetLinkRevision: 1 } };
            return refusal;
        } } };
        let environmentsCreated = 0;
        const result = await createEnvironmentWithCopyForHost({ input, context: outcome === 'noChild' ? {} : context }, {
            async create() { environmentsCreated++; return { ok: true, environmentId: base.environment.id, revision: 1,
                ...(outcome === 'created' ? { projectSourceId: 'destination', runtimeTargetLinkId: 'created-runtime' } : {}) }; },
            async readEnvironment() { return { environment: { ...base.environment, revision: 1 }, content: base.content,
                targetLinks: base.targetLinks.map(link => link.targetLink) }; },
        });
        if (outcome === 'noChild') {
            expect(result).toMatchObject({ ok: false, errorCode: 'client_required' });
            expect(environmentsCreated).toBe(0);
            expect(invoked).toHaveLength(0);
            return;
        }
        expect(invoked[0]).toMatchObject({ action: provision.action,
            input: { ...provision.input, environmentId: base.environment.id, expectedRevision: 1 } });
        if (outcome === 'created') {
            expect(result).toEqual({ ok: true, environmentId: base.environment.id, revision: 2,
                projectSourceId: 'destination', runtimeTargetLinkId: 'created-runtime' });
            expect(invoked).toHaveLength(2);
            return;
        }
        expect(result).toMatchObject({ ok: false, details: { kind: 'partial', phase: 'target', environmentId: base.environment.id } });
        if (outcome === 'linkRefused') expect(result).toMatchObject({ ...refusal, details: {
            kind: 'partial', phase: 'target', requiredFact: refusal.details.requiredFact,
            remedy: expect.stringContaining(refusal.details.remedy), environmentId: base.environment.id } });
        if (!('details' in result)) throw new Error('Expected partial result');
        expect(DeploymentTemplateInstantiationPartialV1Schema.safeParse(result.details).success).toBe(true);
        if (outcome === 'failedBeforeEffect') {
            expect(invoked).toHaveLength(1);
            expect(result.details).toMatchObject({ continuation: { actionId: 'action.invoke',
                input: { action: provision.action, input: { ...provision.input, environmentId: base.environment.id, expectedRevision: 1 } } } });
            return;
        }
        if (outcome === 'outcomeUnknown' || outcome === 'failedWithoutEffectEvidence') {
            expect(invoked).toHaveLength(1);
            expect(result.details).not.toHaveProperty('continuation');
        } else {
            expect(invoked[1]).toMatchObject({ action: 'deployments.targets.link', input: {
                environmentId: base.environment.id, provider: { credentialPrincipal: principal,
                    providerIdentity: identity, providerEnvironment: environment } } });
            expect(result.details).toMatchObject({ continuation: { actionId: 'deployments.targets.link' } });
            expect(result.details).toMatchObject({ savedSecrets: [{ name: 'DATABASE_URL', phase: 'runtime',
                source: { kind: 'secret', ref: 'happier:shared-secret:v1:created', resourceRevision: 2 } }] });
            if (outcome === 'pending') {
                expect(invoked).toHaveLength(2);
                expect(result.details).toMatchObject({ requiredFact: expect.stringContaining('data:later-data:createEmpty'),
                    remedy: expect.stringContaining(refusal.details.remedy) });
                expect(result.details).toMatchObject({ requiredFact: expect.stringContaining(refusal.details.requiredFact) });
            }
        }
    });
    it('preserves the created Environment and binding continuation when the later binding Action is forbidden', async () => {
        const base = createDeploymentEnvironmentDetailV1();
        const binding = { purpose: 'variable' as const, name: 'PUBLIC', phase: 'runtime' as const,
            source: { kind: 'value' as const, value: 'included' } };
        const input = DeploymentEnvironmentCreateInputV1Schema.parse({ serverId: 'home', projectSourceId: 'destination',
            requestKey: 'copy', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: 'controller', contentArtifactId: base.environment.contentArtifactId,
            contentHeaderVersion: base.environment.contentHeaderVersion, contentBodyVersion: base.environment.contentBodyVersion,
            copyIntentCommitment: 'A'.repeat(43),
            copyFrom: { environmentId: 'source', expectedRevision: 7, choices: { secrets: [],
                values: [{ binding: { purpose: 'variable', name: 'PUBLIC', phase: 'runtime' }, kind: 'include' }], data: [] } },
            copyPlan: { bindings: [binding] } });
        const invocations: unknown[] = [];
        const refusal = { ok: false as const, errorCode: 'action_forbidden', error: 'action_forbidden',
            requestId: 'copy-binding-refusal', details: { requiredFact: 'verification_purpose', remedy: 'Retry the admitted binding Action' },
            failureCause: { phase: 'deployments.bindings.set',
                errorClass: 'Error' as const, errorCode: 'action_forbidden', httpStatus: 403 } };
        const context: ActionExecutorContext = { hostReviewedChild: { async invoke(request) {
            invocations.push(request);
            return refusal;
        } } };
        // Backing Environment storage and the admitted child Action are process boundaries.
        const result = await createEnvironmentWithCopyForHost({ input, context }, {
            async create() { return { ok: true, environmentId: base.environment.id, revision: 1 }; },
            async readEnvironment() { return { environment: { ...base.environment, revision: 1 },
                content: { ...base.content, bindings: [] }, targetLinks: base.targetLinks.map(link => link.targetLink) }; },
        });
        expect(result).toMatchObject({ ...refusal, details: {
            kind: 'partial', phase: 'bindings', errorCode: 'action_forbidden', savedSecrets: [],
            ...refusal.details,
            environmentId: base.environment.id, revision: 1,
            continuation: { actionId: 'deployments.bindings.set', input: { environmentId: base.environment.id,
                expectedRevision: 1, set: [binding], remove: [] } },
        } });
        if (!('details' in result)) throw new Error('Expected acknowledged partial result');
        expect(DeploymentTemplateInstantiationPartialV1Schema.safeParse(result.details).success).toBe(true);
        expect(invocations).toHaveLength(1);
    });
});
