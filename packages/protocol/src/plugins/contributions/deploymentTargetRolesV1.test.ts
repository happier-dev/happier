import { expect, it } from 'vitest';
import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs, DeploymentTargetRoleResultV1Schema } from './deploymentTargetRolesV1.js';

it('retains provider-observed built-in addresses separately from deployment URLs', () => {
    const result = { v: 1, state: 'succeeded', observedAtMs: 1,
        urls: ['https://app-exact.vercel.app'], builtInUrls: ['https://app.vercel.app'] };
    expect(DeploymentTargetRoleResultV1Schema.parse(result)).toEqual(result);
    expect(DeploymentTargetRoleResultV1Schema.parse({ ...result, builtInUrls: [] })).toHaveProperty('builtInUrls', []);
});

it('retains positive provider absence evidence through the lifecycle result boundary', () => {
    expect(DeploymentTargetRoleResultV1Schema.parse({ v: 1, state: 'succeeded', observedAtMs: 1,
        providerResourceAbsent: true })).toMatchObject({ providerResourceAbsent: true });
    expect(DeploymentTargetRoleResultV1Schema.safeParse({ v: 1, state: 'succeeded', observedAtMs: 1,
        providerResourceAbsent: false }).success).toBe(false);
});

it('requires reviewed create coordinates without fabricating a provider resource identity', () => {
    const credentialRef = { service: { pluginId: 'example.provider', localId: 'account' }, accountId: 'profile' };
    const input = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
        credentialRef, credentialPrincipal: { kind: 'account', accountId: 'owner',
            purpose: { consumer: { pluginId: 'example.provider', localId: 'create' }, purpose: 'deploy' },
            target: { kind: 'account', account: credentialRef } },
        providerAccountId: 'native-account', providerEnvironment: { kind: 'production' },
        requestKey: 'reviewed-request', resourceName: 'application', productionBranch: 'trunk', sourceMethod: 'upload' };
    const schema = Reflect.get(inputs, 'create');
    expect(schema.parse(input)).toEqual(input);
    for (const key of ['environmentId', 'expectedRevision', 'providerAccountId', 'requestKey', 'resourceName']) {
        const missing = { ...input };
        Reflect.deleteProperty(missing, key);
        expect(schema.safeParse(missing).success).toBe(false);
    }
    expect(schema.safeParse({ ...input, providerIdentity: {
        providerAccountId: 'native-account', providerResourceId: 'fabricated', providerEnvironment: 'production',
    } }).success).toBe(false);
    expect(schema.safeParse({ ...input, targetLinkId: 'existing', expectedTargetLinkRevision: 1 }).success).toBe(false);
});
