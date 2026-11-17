import { describe, expect, it } from 'vitest';
import { DeploymentReadAdmissionV1Schema, projectDeploymentReadAdmissionV1 } from './deploymentReadAdmissionV1';
import { DeploymentLogsReadInputV1Schema, DeploymentLogsReadSuccessV1Schema, DeploymentHealthReadInputV1Schema } from './deploymentReadsV1';
import { PluginUiDeploymentStageLogsReadReferenceV1Schema } from '../daemon/machineServiceLogsResource';
import { FileSaveInputSchema } from '../actions/fileSaveActionFamily';
import { DATABASE_STATEMENT_RUN_ACTION_ID_V1 } from '../actions/actionIdsDatabaseV1';
import { parseQualifiedPluginActionId } from '../plugins/actions/qualifiedActionId';

describe('target-shaped deployment logs', () => {
    it.each(['build', 'runtime'] as const)('returns platform %s logs without inventing Machine coordinates', kind => {
        const result = { ok: true, environmentId: 'environment', deploymentId: 'deployment', targetLinkId: 'link', kind,
            logs: { kind: 'page', page: { sourceRevision: 'provider-deployment', text: 'ready', nextCursor: null, truncated: false } } };
        expect(DeploymentLogsReadSuccessV1Schema.parse(result)).toEqual(result);
    });
    it.each(['build', 'runtime'] as const)('admits a compact platform %s read and follows the same reference', kind => {
        const input = { serverId: 'home', environmentId: 'environment', deploymentId: 'deployment', kind };
        expect(DeploymentLogsReadInputV1Schema.parse(input)).toEqual(input);
        expect(DeploymentReadAdmissionV1Schema.parse(projectDeploymentReadAdmissionV1('deployments.logs.read', input)))
            .toEqual({ actionId: 'deployments.logs.read', environmentId: 'environment', deploymentId: 'deployment', kind });
        expect(PluginUiDeploymentStageLogsReadReferenceV1Schema.parse({ hostRead: 'deployments.logs',
            input: { ...input, ...(kind === 'build' ? { tail: true } : {}) }, sourceRevision: 'provider-deployment' }))
            .toHaveProperty('input.deploymentId', 'deployment');
        if (kind === 'build') expect(FileSaveInputSchema.parse({ fileName: 'build.log', source: {
            kind: 'deploymentLog', reference: input } })).toHaveProperty('source.reference', input);
        expect(DeploymentLogsReadInputV1Schema.safeParse({ ...input, arbitrary: true }).success).toBe(false);
        expect(DeploymentHealthReadInputV1Schema.safeParse(input).success).toBe(false);
    });
});

describe('deployment current-health read admission', () => {
    it('binds a native size read to its exact service without a SQL operand', () => {
        const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 3,
            deploymentId: 'deployment', targetLinkId: 'link', machineId: 'machine', installationId: 'installation',
            service: 'postgres' };
        const admission = projectDeploymentReadAdmissionV1('deployments.data.size', input);
        expect(DeploymentReadAdmissionV1Schema.parse(admission)).toEqual({ actionId: 'deployments.data.size',
            environmentId: input.environmentId, expectedRevision: input.expectedRevision,
            deploymentId: input.deploymentId, targetLinkId: input.targetLinkId, machineId: input.machineId,
            installationId: input.installationId, service: input.service });
        expect(DeploymentReadAdmissionV1Schema.safeParse({ ...admission, sql: 'SELECT 1' }).success).toBe(false);
    });

    it.each(['deployment_service', 'managed_deployment'] as const)('projects the selected %s for semantic SQL without publishing SQL or credentials', kind => {
        const action = parseQualifiedPluginActionId(DATABASE_STATEMENT_RUN_ACTION_ID_V1);
        if (!action) throw new Error('The canonical database Action has a qualified identity');
        const environment = { serverId: 'home', projectSourceId: 'project', environmentId: 'environment' };
        const databaseTarget = kind === 'deployment_service'
            ? { kind, environment, deploymentId: 'deployment', targetLinkId: 'link', serviceId: 'postgres', database: 'restored' }
            : { kind, environment, targetLinkId: 'link', contribution: { pluginId: 'happier.deploy.neon', contributionId: 'neon' },
                platformProjectId: 'provider-project', branchId: 'preview-branch', database: 'restored' };
        const input = { action, input: { operation: 'statement.run', mode: 'read', target: databaseTarget,
            statement: { sql: 'SELECT $1', parameters: [{ type: 'text', value: 'private-sentinel' }] } } };
        const admission = projectDeploymentReadAdmissionV1('action.invoke', input);
        expect(DeploymentReadAdmissionV1Schema.parse(admission)).toEqual({ actionId: 'action.invoke', action,
            environmentId: environment.environmentId, targetLinkId: databaseTarget.targetLinkId, databaseTarget, access: 'read' });
        expect(DeploymentReadAdmissionV1Schema.parse(projectDeploymentReadAdmissionV1('action.invoke', {
            action, input: { operation: 'statement.run', mode: 'write', target: databaseTarget,
                executionMode: 'transaction', statements: [{ sql: 'UPDATE selected SET value=$1',
                    parameters: [{ type: 'text', value: 'private-sentinel' }] }] },
        }))).toEqual({ actionId: 'action.invoke', action, environmentId: environment.environmentId,
            targetLinkId: databaseTarget.targetLinkId, databaseTarget, access: 'write' });
        expect(JSON.stringify(admission)).not.toContain('private-sentinel');
        expect(projectDeploymentReadAdmissionV1('action.invoke', { ...input,
            action: { pluginId: 'foreign.plugin', localId: action.localId } })).toBeUndefined();
        expect(projectDeploymentReadAdmissionV1('action.invoke', { ...input,
            input: { ...input.input, target: { ...databaseTarget, password: 'caller-credential' } } })).toBeUndefined();
    });

    it('binds the read-only current edge to one Environment, link and controller without a receipt', () => {
        const input = { serverId: 'server', environmentId: 'environment', targetLinkId: 'link', machineId: 'controller' };
        const admission = projectDeploymentReadAdmissionV1('deployments.health.current', input);
        expect(DeploymentReadAdmissionV1Schema.parse(admission)).toEqual({ actionId: 'deployments.health.current',
            environmentId: 'environment', targetLinkId: 'link', machineId: 'controller' });
        expect(DeploymentReadAdmissionV1Schema.safeParse({ ...admission, deploymentId: 'fabricated' }).success).toBe(false);
    });

    it('does not admit retired native or provider query operands', () => {
        // P1 R6 retires both query surfaces after semantic selected-target coverage above.
        const native = { serverId: 'home', environmentId: 'environment', expectedRevision: 4,
            deploymentId: 'deployment', targetLinkId: 'link', machineId: 'machine', installationId: 'installation',
            service: 'postgres', sql: 'SELECT 1', params: {} };
        expect(projectDeploymentReadAdmissionV1('deployments.data.query', native)).toBeUndefined();
        expect(DeploymentReadAdmissionV1Schema.safeParse({ actionId: 'deployments.data.query',
            environmentId: native.environmentId, expectedRevision: native.expectedRevision, deploymentId: native.deploymentId,
            targetLinkId: native.targetLinkId, machineId: native.machineId, installationId: native.installationId }).success).toBe(false);
        const action = { pluginId: 'happier.deploy.neon', localId: 'query-read' };
        const credentialRef = { service: { pluginId: action.pluginId, localId: 'neon' }, accountId: 'connected' };
        const input = { v: 1, serverId: native.serverId, environmentId: native.environmentId, expectedRevision: 4,
            targetLinkId: 'data-link', expectedTargetLinkRevision: 3, credentialRef,
            credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: action, purpose: 'deploy-manage' },
                target: { kind: 'account', account: credentialRef } },
            providerIdentity: { providerAccountId: 'org', providerResourceId: 'project', providerEnvironment: 'branch' },
            providerEnvironment: { kind: 'custom', id: 'branch' }, database: 'neondb', sql: 'select 1', params: {} };
        expect(projectDeploymentReadAdmissionV1('action.invoke', { action, input })).toBeUndefined();
        expect(DeploymentReadAdmissionV1Schema.safeParse({ actionId: 'action.invoke', action,
            environmentId: native.environmentId, targetLinkId: input.targetLinkId, expectedRevision: 4,
            expectedTargetLinkRevision: 3 }).success).toBe(false);
    });
});
