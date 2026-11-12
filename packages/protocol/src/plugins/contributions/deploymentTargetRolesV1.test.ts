import { expect, it } from 'vitest';
import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs } from './deploymentTargetRolesV1.js';

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
