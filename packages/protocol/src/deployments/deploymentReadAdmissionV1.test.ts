import { describe, expect, it } from 'vitest';
import { DeploymentReadAdmissionV1Schema, projectDeploymentReadAdmissionV1 } from './deploymentReadAdmissionV1';
import { DeploymentLogsReadInputV1Schema, DeploymentLogsReadSuccessV1Schema, DeploymentHealthReadInputV1Schema } from './deploymentReadsV1';
import { PluginUiDeploymentStageLogsReadReferenceV1Schema } from '../daemon/machineServiceLogsResource';
import { FileSaveInputSchema } from '../actions/fileSaveActionFamily';

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
    it('binds the read-only current edge to one Environment, link and controller without a receipt', () => {
        const input = { serverId: 'server', environmentId: 'environment', targetLinkId: 'link', machineId: 'controller' };
        const admission = projectDeploymentReadAdmissionV1('deployments.health.current', input);
        expect(DeploymentReadAdmissionV1Schema.parse(admission)).toEqual({ actionId: 'deployments.health.current',
            environmentId: 'environment', targetLinkId: 'link', machineId: 'controller' });
        expect(DeploymentReadAdmissionV1Schema.safeParse({ ...admission, deploymentId: 'fabricated' }).success).toBe(false);
    });

    it('binds a qualified managed data query to its exact selected link and contributor', () => {
        const action = { pluginId: 'happier.deploy.neon', localId: 'query-read' };
        const credentialRef = { service: { pluginId: 'happier.deploy.neon', localId: 'neon' }, accountId: 'connected' };
        const input = {
            action,
            input: {
                v: 1, serverId: 'server', environmentId: 'environment', expectedRevision: 4,
                targetLinkId: 'data-link', expectedTargetLinkRevision: 3, credentialRef,
                credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
                    consumer: action, purpose: 'deploy-manage',
                }, target: { kind: 'account', account: credentialRef } },
                providerIdentity: { providerAccountId: 'org', providerResourceId: 'project', providerEnvironment: 'branch' },
                providerEnvironment: { kind: 'custom', id: 'branch' },
                database: 'neondb', sql: 'select 1', params: {},
            },
        };

        const admission = projectDeploymentReadAdmissionV1('action.invoke', input);

        expect(DeploymentReadAdmissionV1Schema.parse(admission)).toEqual({
            actionId: 'action.invoke', action, environmentId: 'environment', targetLinkId: 'data-link',
            expectedRevision: 4, expectedTargetLinkRevision: 3,
        });
        expect(projectDeploymentReadAdmissionV1('action.invoke', {
            ...input, action: { pluginId: 'happier.deploy.supabase', localId: 'query-read' },
        })).toEqual({
            actionId: 'action.invoke', action: { pluginId: 'happier.deploy.supabase', localId: 'query-read' },
            environmentId: 'environment', targetLinkId: 'data-link', expectedRevision: 4, expectedTargetLinkRevision: 3,
        });
        expect(projectDeploymentReadAdmissionV1('action.invoke', {
            ...input, input: { ...input.input, expectedTargetLinkRevision: 2 },
        })).toEqual({
            actionId: 'action.invoke', action, environmentId: 'environment', targetLinkId: 'data-link',
            expectedRevision: 4, expectedTargetLinkRevision: 2,
        });
        expect(projectDeploymentReadAdmissionV1('action.invoke', { action, input: { arbitrary: true } })).toBeUndefined();
    });
});
