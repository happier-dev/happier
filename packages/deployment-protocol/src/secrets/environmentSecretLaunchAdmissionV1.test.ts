import { describe, expect, it } from 'vitest';
import { EnvironmentSecretClientBindingsInputV1Schema, EnvironmentSecretLaunchAdmissionBodyV1Schema,
    EnvironmentSecretLaunchAdmissionInputV1Schema } from './environmentSecretLaunchAdmissionV1.js';

describe('Environment secret launch data-role materialization', () => {
    const receiver = { serverId: 'server', environmentId: 'environment', targetLinkId: 'managed-link',
        machineId: 'controller', installationId: 'controller-installation' };
    const proof = { version: 1 as const, algorithm: 'ed25519' as const, signature: 'A'.repeat(86) };

    it('keeps native-service and managed-link role addresses mutually exclusive', () => {
        expect(EnvironmentSecretLaunchAdmissionBodyV1Schema.parse({ ...receiver, materialization: {
            kind: 'dataRole', expectedRevision: 3, targetLinkId: receiver.targetLinkId,
        } })).toMatchObject({ materialization: { kind: 'dataRole', expectedRevision: 3,
            targetLinkId: receiver.targetLinkId } });
        expect(EnvironmentSecretLaunchAdmissionBodyV1Schema.safeParse({ ...receiver, materialization: {
            kind: 'dataRole', expectedRevision: 3, deploymentId: 'deployment', service: 'postgres',
            targetLinkId: receiver.targetLinkId,
        } }).success).toBe(false);
        expect(EnvironmentSecretLaunchAdmissionBodyV1Schema.safeParse({ ...receiver, targetLinkId: 'other-link', materialization: {
            kind: 'dataRole', expectedRevision: 3, targetLinkId: receiver.targetLinkId,
        } }).success).toBe(false);
        expect(EnvironmentSecretLaunchAdmissionInputV1Schema.parse({ ...receiver, materialization: {
            kind: 'dataRole', expectedRevision: 3, targetLinkId: receiver.targetLinkId,
        }, proof })).toMatchObject({ targetLinkId: receiver.targetLinkId, materialization: {
            targetLinkId: receiver.targetLinkId,
        } });
        expect(EnvironmentSecretLaunchAdmissionInputV1Schema.safeParse({ ...receiver, targetLinkId: 'other-link', materialization: {
            kind: 'dataRole', expectedRevision: 3, targetLinkId: receiver.targetLinkId,
        }, proof }).success).toBe(false);
    });

    it('carries only distinct managed role links into binding preparation', () => {
        expect(EnvironmentSecretLaunchAdmissionBodyV1Schema.parse({ ...receiver, materialization: {
            kind: 'bindings', expectedRevision: 3, dataRoleTargetLinkIds: ['managed-link', 'other-managed-link'],
        } })).toMatchObject({ materialization: { kind: 'bindings', expectedRevision: 3,
            dataRoleTargetLinkIds: ['managed-link', 'other-managed-link'] } });
        expect(EnvironmentSecretLaunchAdmissionBodyV1Schema.safeParse({ ...receiver, materialization: {
            kind: 'bindings', expectedRevision: 3, dataRoleTargetLinkIds: ['managed-link', 'managed-link'],
        } }).success).toBe(false);
        expect(EnvironmentSecretClientBindingsInputV1Schema.parse({ kind: 'clientBindings', serverId: receiver.serverId,
            environmentId: receiver.environmentId, expectedRevision: 3,
            dataRoleTargetLinkIds: ['managed-link', 'other-managed-link'] })).toMatchObject({
            dataRoleTargetLinkIds: ['managed-link', 'other-managed-link'],
        });
        expect(EnvironmentSecretClientBindingsInputV1Schema.safeParse({ kind: 'clientBindings', serverId: receiver.serverId,
            environmentId: receiver.environmentId, expectedRevision: 3,
            dataRoleTargetLinkIds: ['managed-link', 'managed-link'] }).success).toBe(false);
    });
});
