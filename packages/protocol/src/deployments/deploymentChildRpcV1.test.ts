import { describe, expect, it } from 'vitest';
import { DeploymentDomainDiscoverChildRpcV1Schema } from './deploymentChildRpcV1.js';

describe('Domain discovery child RPC', () => {
    it.each(['deployments.domains.add', 'deployments.domains.remove'] as const)(
        'parses the prepared %s child and rejects undeclared fields', actionId => {
            const child = {
                v: 1, kind: 'domainDiscover', machineId: 'machine', installationId: 'installation', actionId,
                input: {
                    serverId: 'home', environmentId: 'environment', domainId: 'domain',
                    expectedRevision: 1, requestKey: 'request', expectedDomainRevision: 1,
                    targetLinkId: 'target', expectedTargetLinkRevision: 1,
                    contentArtifactId: 'content', contentHeaderVersion: 1, contentBodyVersion: 1,
                },
            };

            expect(DeploymentDomainDiscoverChildRpcV1Schema.parse(child)).toEqual(child);
            expect(DeploymentDomainDiscoverChildRpcV1Schema.safeParse({ ...child, extra: true }).success).toBe(false);
            expect(DeploymentDomainDiscoverChildRpcV1Schema.safeParse({
                ...child, input: { ...child.input, extra: true },
            }).success).toBe(false);
        },
    );
});
