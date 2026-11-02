import { describe, expect, it } from 'vitest';

import { createDeploymentEnvironmentV1 } from '../testing/v1.js';
import { DeploymentEnvironmentContentV1Schema, DeploymentSecretBindingSourceV1Schema,
    EnvironmentSecretBindingV1Schema, EnvironmentVariableBindingV1Schema } from './environment.js';

const secret = DeploymentSecretBindingSourceV1Schema.parse({
    kind: 'secret', ref: 'happier:shared-secret:v1:resource-a', resourceRevision: 2,
});
const registry = { purpose: 'registry', targetLinkId: 'target-a', registryOrigin: 'https://registry.example.com', access: 'pull', source: secret };
const backup = { purpose: 'backupDestination', configKey: 'destination', role: 'sshPrivateKey', source: secret };
const domain = { purpose: 'domainCredential', domainId: 'domain-a', role: 'privateKey', source: secret };
const serviceRole = { purpose: 'dataRole', service: 'postgres', role: 'readOnlyPassword', source: secret };
const managedRole = { purpose: 'dataRole', targetLinkId: 'data-link', role: 'readOnlyPassword', source: secret };

function contentWith(bindings: readonly unknown[]) {
    const environment = createDeploymentEnvironmentV1();
    if (environment.content.t !== 'plain') throw new Error('Expected opened fixture content');
    return { ...environment.content.v, bindings };
}

describe('Environment binding purpose contracts', () => {
    it('round-trips the five purposes and both data-role addresses through the existing content owner', () => {
        const variable = EnvironmentVariableBindingV1Schema.parse({ purpose: 'variable', name: 'TOKEN', phase: 'runtime', source: secret });
        const bindings = [variable, registry, backup, domain, serviceRole, managedRole];
        expect(DeploymentEnvironmentContentV1Schema.parse(contentWith(bindings)).bindings).toEqual(bindings);
    });

    it.each([registry, backup, domain, serviceRole, managedRole])('keeps $purpose secret-only and outside application variables', binding => {
        expect(EnvironmentSecretBindingV1Schema.safeParse(binding).success).toBe(true);
        expect(EnvironmentVariableBindingV1Schema.safeParse(binding).success).toBe(false);
        for (const source of [{ kind: 'value', value: 'public' },
            { kind: 'reference', environmentId: 'data', export: 'url', via: 'auto' },
            { kind: 'deploymentFact', fact: 'primaryUrl' }]) {
            expect(EnvironmentSecretBindingV1Schema.safeParse({ ...binding, source }).success).toBe(false);
        }
        expect(EnvironmentSecretBindingV1Schema.safeParse({ ...binding, name: 'AUTH', phase: 'runtime' }).success).toBe(false);
    });

    it('admits all closed backup and Domain roles, rejecting misplaced roles and configuration', () => {
        for (const role of ['accessKeyId', 'secretAccessKey', 'sessionToken', 'repositoryPassword', 'sshPrivateKey']) {
            expect(EnvironmentSecretBindingV1Schema.safeParse({ ...backup, role }).success).toBe(true);
        }
        for (const role of ['basicAuth', 'certificateChain', 'privateKey']) {
            expect(EnvironmentSecretBindingV1Schema.safeParse({ ...domain, role }).success).toBe(true);
        }
        expect(EnvironmentSecretBindingV1Schema.safeParse({ ...backup, configKey: 'other' }).success).toBe(false);
        expect(EnvironmentSecretBindingV1Schema.safeParse({ ...backup, role: 'privateKey' }).success).toBe(false);
        expect(EnvironmentSecretBindingV1Schema.safeParse({ ...domain, role: 'sshPrivateKey' }).success).toBe(false);
        expect(EnvironmentSecretBindingV1Schema.safeParse({ ...domain, domainId: '' }).success).toBe(false);
    });

    it('requires a canonical registry origin and explicit pull or pushPull access', () => {
        expect(EnvironmentSecretBindingV1Schema.parse({ ...registry, access: 'pushPull' })).toEqual({ ...registry, access: 'pushPull' });
        for (const registryOrigin of ['https://registry.example.com/', 'https://user:pass@registry.example.com',
            'https://registry.example.com/path', 'https://registry.example.com?q=x', 'https://registry.example.com#x', 'registry.example.com']) {
            expect(EnvironmentSecretBindingV1Schema.safeParse({ ...registry, registryOrigin }).success).toBe(false);
        }
        expect(EnvironmentSecretBindingV1Schema.safeParse({ ...registry, access: undefined }).success).toBe(false);
        expect(EnvironmentSecretBindingV1Schema.safeParse({ ...registry, access: 'push' }).success).toBe(false);
    });

    it('requires exactly one data-role address without a synthetic self-hosted target', () => {
        expect(EnvironmentSecretBindingV1Schema.parse(serviceRole)).toEqual(serviceRole);
        expect(EnvironmentSecretBindingV1Schema.parse(managedRole)).toEqual(managedRole);
        expect(EnvironmentSecretBindingV1Schema.safeParse({ ...serviceRole, targetLinkId: 'data-link' }).success).toBe(false);
        expect(EnvironmentSecretBindingV1Schema.safeParse({ purpose: 'dataRole', role: 'readOnlyPassword', source: secret }).success).toBe(false);
        expect(EnvironmentSecretBindingV1Schema.safeParse({ ...serviceRole, environmentId: 'copied-owner' }).success).toBe(false);
        expect(EnvironmentSecretBindingV1Schema.safeParse({ ...serviceRole, service: '' }).success).toBe(false);
        expect(EnvironmentSecretBindingV1Schema.safeParse({ ...managedRole, targetLinkId: '' }).success).toBe(false);
    });

    it('uses purpose-specific identities and treats registry access and secret revision as replacements', () => {
        for (const binding of [registry, backup, domain, serviceRole, managedRole]) {
            expect(DeploymentEnvironmentContentV1Schema.safeParse(contentWith([binding,
                { ...binding, source: { ...secret, resourceRevision: 3 } }])).success).toBe(false);
        }
        expect(DeploymentEnvironmentContentV1Schema.safeParse(contentWith([registry, { ...registry, access: 'pushPull' }])).success).toBe(false);
        const distinct = [registry, { ...registry, targetLinkId: 'target-b' }, { ...registry, registryOrigin: 'https://other.example.com' },
            backup, { ...backup, role: 'repositoryPassword' }, domain, { ...domain, domainId: 'domain-b' }, { ...domain, role: 'certificateChain' },
            serviceRole, { ...serviceRole, service: 'redis' }, managedRole, { ...managedRole, targetLinkId: 'postgres' }];
        expect(DeploymentEnvironmentContentV1Schema.parse(contentWith(distinct)).bindings).toEqual(distinct);
    });

    it('round-trips strict nonsecret deployment facts at the existing shared variable-source owner', () => {
        const sources: unknown[] = ['primaryUrl', 'commitSha', 'deploymentId', 'environmentName'].map(fact => ({ kind: 'deploymentFact', fact }));
        sources.push({ kind: 'deploymentFact', fact: 'domainUrl', domainId: 'domain-a' });
        for (const source of sources) {
            const binding = { purpose: 'variable', phase: 'runtime', name: 'FACT', source };
            expect(EnvironmentVariableBindingV1Schema.parse(binding)).toEqual(binding);
            expect(EnvironmentSecretBindingV1Schema.parse(binding)).toEqual(binding);
        }
        for (const source of [{ kind: 'deploymentFact', fact: 'domainUrl' },
            { kind: 'deploymentFact', fact: 'primaryUrl', domainId: 'domain-a' },
            { kind: 'deploymentFact', fact: 'domainUrl', domainId: '' }, { kind: 'deploymentFact', fact: 'unknown' }]) {
            expect(EnvironmentVariableBindingV1Schema.safeParse({ purpose: 'variable', phase: 'runtime', name: 'FACT', source }).success).toBe(false);
        }
    });
});
