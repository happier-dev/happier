import { settleActionOutput } from '@happier-dev/protocol/actions/executor/resultProjection';
import { describe, expect, it } from 'vitest';
import { DeploymentEnvironmentCreateInputV1Schema, DeploymentBindingsSetInputV1Schema, DeploymentTemplateInstantiationPartialV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { EnvironmentSecretBindingV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createEnvironmentWithCopyForHost } from './copyEnvironmentForHost';

describe('Copy acknowledged step result', () => {
    it.each(['applied', 'changedValue', 'changedName', 'changedPhase', 'missing', 'extra'] as const)(
        'recognizes writer-minted references without accepting %s binding drift', async state => {
            const base = createDeploymentEnvironmentDetailV1();
            const binding = createDeploymentVariableBindingV1({ name: 'PUBLIC', phase: 'runtime', source: { kind: 'value', value: 'reviewed' } });
            const stored = createDeploymentVariableBindingV1({ ...binding,
                grantRef: 'a3706c68-cd7e-4201-a9b0-71df13984152',
                ...(state === 'changedValue' ? { source: { kind: 'value' as const, value: 'changed' } } : {}),
                ...(state === 'changedName' ? { name: 'OTHER' } : {}),
                ...(state === 'changedPhase' ? { phase: 'build' as const } : {}),
            });
            const bindings = state === 'missing' ? [] : state === 'extra'
                ? [stored, createDeploymentVariableBindingV1({ ...stored, name: 'EXTRA', grantRef: crypto.randomUUID() })] : [stored];
            const input = DeploymentEnvironmentCreateInputV1Schema.parse({ serverId: 'home', projectSourceId: 'destination',
                requestKey: 'copy', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: 'controller', contentArtifactId: base.environment.contentArtifactId,
                contentHeaderVersion: base.environment.contentHeaderVersion, contentBodyVersion: base.environment.contentBodyVersion,
                copyIntentCommitment: 'A'.repeat(43), copyFrom: { environmentId: 'source', expectedRevision: 7,
                    choices: { secrets: [], values: [{ kind: 'include', binding: { purpose: 'variable', name: 'PUBLIC', phase: 'runtime' } }], data: [] } },
                copyPlan: { bindings: [binding] } });
            // Home has committed the binding write, but its acknowledgement was lost.
            const result = await createEnvironmentWithCopyForHost({ input, context: { hostReviewedChild: { async invoke() {
                throw new Error('A committed or independently changed binding must not be written again');
            } } } }, {
                async create() { return { ok: true, environmentId: base.environment.id, revision: 1, replayed: true }; },
                async readEnvironment() { return { environment: { ...base.environment, revision: 2,
                    contentBodyVersion: base.environment.contentBodyVersion + 1 },
                    content: { ...base.content, bindings }, targetLinks: [] }; },
            });
            expect(result).toMatchObject(state === 'applied'
                ? { ok: true, environmentId: base.environment.id, revision: 2 }
                : { ok: false, errorCode: 'deployment_conflict', details: { phase: 'bindings' } });
        });

    it('carries a pre-grant stored reference through Create to the fresh bindings Action', async () => {
        const base = createDeploymentEnvironmentDetailV1();
        const binding = { purpose: 'variable', name: 'DATABASE_URL', phase: 'runtime',
            source: { kind: 'reference', environmentId: 'source', export: 'DATABASE_URL', via: 'auto' } };
        const input = DeploymentEnvironmentCreateInputV1Schema.parse({ serverId: 'home', projectSourceId: 'destination',
            requestKey: 'copy', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: 'controller', contentArtifactId: base.environment.contentArtifactId,
            contentHeaderVersion: base.environment.contentHeaderVersion, contentBodyVersion: base.environment.contentBodyVersion,
            copyIntentCommitment: 'A'.repeat(43), copyFrom: { environmentId: 'source', expectedRevision: 7,
                choices: { secrets: [], values: [{ kind: 'include', binding: { purpose: 'variable', name: 'DATABASE_URL', phase: 'runtime' } }], data: [] } },
            copyPlan: { bindings: [binding] } });
        let bound = false;
        const result = await createEnvironmentWithCopyForHost({ input, context: { hostReviewedChild: { async invoke(request) {
            expect(request.action).toBe('deployments.bindings.set');
            const selection = DeploymentBindingsSetInputV1Schema.parse(request.input);
            expect(selection.set).toEqual([binding]);
            bound = true;
            return { ok: true, result: { ok: true, environmentId: base.environment.id, revision: 2 } };
        } } } }, {
            async create() { return { ok: true, environmentId: base.environment.id, revision: 1, replayed: false }; },
            async readEnvironment() { return { environment: { ...base.environment, revision: 1 },
                content: { ...base.content, bindings: [] }, targetLinks: [] }; },
        });
        expect(result).toMatchObject({ ok: true, environmentId: base.environment.id, revision: 2 });
        expect(bound).toBe(true);
        expect(EnvironmentSecretBindingV1Schema.safeParse(binding).success).toBe(false);
    });

    it.each(['linkRefused', 'pending', 'created', 'outcomeUnknown', 'failedWithoutEffectEvidence', 'failedBeforeEffect', 'allocationMissing', 'allocationFresh', 'allocationReplay', 'noChild'] as const)('creates managed data with fresh Action custody and retains %s outcomes', async outcome => {
        const base = createDeploymentEnvironmentDetailV1();
        const principal = { kind: 'account', accountId: 'owner',
            purpose: { consumer: { pluginId: 'com.example.data', localId: 'provision' }, purpose: 'manage' },
            target: { kind: 'account', account: { service: { pluginId: 'com.example.data', localId: 'account' }, accountId: 'new-account' } } };
        const provision = { action: { pluginId: 'com.example.data', localId: 'provision' }, input: {
            v: 1, serverId: 'home', credentialRef: principal.target.account, credentialPrincipal: principal,
            providerAccountId: 'new-provider-account', providerEnvironment: { kind: 'native', selection: { branchId: 'new' } }, name: 'empty-copy',
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
        const environment = { kind: 'native', selection: { branchId: 'new' } };
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
            if (outcome === 'created' || outcome === 'allocationFresh') return { ok: true, result: { ok: true, environmentId: base.environment.id,
                revision: 2, targetLinkId: 'created-data', targetLinkRevision: 1 } };
            return refusal;
        } } };
        let environmentsCreated = 0;
        const result = await createEnvironmentWithCopyForHost({ input, context: outcome === 'noChild' ? {} : context }, {
            async create() { environmentsCreated++; return { ok: true, environmentId: base.environment.id, revision: 1,
                ...(outcome === 'allocationMissing' ? {} : { replayed: outcome === 'allocationReplay' }),
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
        if (outcome === 'allocationMissing' || outcome === 'allocationReplay') {
            expect(result).toMatchObject({ ok: false, errorCode: 'deployment_conflict', details: {
                kind: 'partial', phase: 'environment', environmentId: base.environment.id, revision: 1 } });
            expect(invoked).toHaveLength(0);
            return;
        }
        if (outcome === 'allocationFresh') {
            expect(result).toMatchObject({ ok: true, environmentId: base.environment.id, revision: 2 });
            expect(invoked).toHaveLength(2);
            return;
        }
        expect(invoked[0]).toMatchObject({ action: provision.action,
            input: { ...provision.input, environmentId: base.environment.id, expectedRevision: 1 } });
        if (outcome === 'created') {
            expect(result).toEqual({ ok: true, environmentId: base.environment.id, revision: 2,
                projectSourceId: 'destination', runtimeTargetLinkId: 'created-runtime', replayed: false });
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
    it('retains partial recovery and private sanitized issues for malformed binding child output', async () => {
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
        const context: ActionExecutorContext = { hostReviewedChild: { async invoke(request) {
            invocations.push(request);
            return { ok: true, result: { ok: true, environmentId: base.environment.id, revision: 'secret-rejected' } };
        } } };
        // Backing Environment storage and the admitted child Action are process boundaries.
        const result = await createEnvironmentWithCopyForHost({ input, context }, {
            async create() { return { ok: true, environmentId: base.environment.id, revision: 1 }; },
            async readEnvironment() { return { environment: { ...base.environment, revision: 1 },
                content: { ...base.content, bindings: [] }, targetLinks: base.targetLinks.map(link => link.targetLink) }; },
        });
        const diagnostics: unknown[] = [];
        const settled = settleActionOutput('deployments.environments.create', result, undefined, undefined,
            diagnostic => { diagnostics.push(diagnostic); });
        expect(settled).toMatchObject({ ok: false, errorCode: 'invalid_action_output', details: {
            kind: 'partial', environmentId: base.environment.id, revision: 1,
            continuation: { actionId: 'deployments.bindings.set' } } });
        expect(diagnostics).toMatchObject([{ issues: expect.arrayContaining([
            { path: ['revision'], code: 'invalid_type', expected: 'number' },
        ]) }]);
        expect(JSON.stringify([settled, diagnostics])).not.toContain('secret-rejected');
    });

});
