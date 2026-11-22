import { describe, expect, it } from 'vitest';
import { DeploymentDomainDiscoverChildRpcV1Schema, DeploymentDomainReviewChildRpcV1Schema, doesDeploymentChildInputMatchRootV1 } from './deploymentChildRpcV1.js';
import { DeploymentChildRoutingV1Schema, projectDeploymentChildRoutingV1 } from './deploymentChildRoutingV1.js';

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

it('keeps a draft Domain in the exact private child operand and out of the signed routing metadata', () => {
    const job = DeploymentDomainReviewChildRpcV1Schema.parse({
        v: 1, kind: 'domainReview', machineId: 'machine', installationId: 'installation', actionId: 'deployments.domains.add',
        input: { serverId: 'home', environmentId: 'environment', domainId: 'domain', targetLinkId: 'target',
            expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'request',
            content: { hostname: 'private.example', target: { service: 'private-app', containerPort: 80 } } },
    });
    const routing = DeploymentChildRoutingV1Schema.parse(projectDeploymentChildRoutingV1(job));
    expect(routing).toMatchObject({ kind: 'domainReview', input: { environmentId: 'environment', targetLinkId: 'target' } });
    expect(routing.input).not.toHaveProperty('content');
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: job.actionId, rootInput: job.input, child: job })).toBe(true);
    expect(doesDeploymentChildInputMatchRootV1({ rootActionId: job.actionId,
        rootInput: { ...job.input, expectedTargetLinkRevision: 2 }, child: job })).toBe(false);
});
