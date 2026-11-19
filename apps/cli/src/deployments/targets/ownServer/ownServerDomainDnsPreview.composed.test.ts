import { expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { DeploymentChildRpcV1Schema, projectDeploymentChildRoutingV1,
    type DeploymentDomainDnsChildRpcV1 } from '@happier-dev/protocol';
import { readDeploymentEnvironmentForHost } from '@/deployments/readEnvironmentForHost';
import { createOwnServerDomainActions } from './ownServerDomainActions';

it.each(['direct', 'edge', 'stale', 'ambiguous', 'cloudflare', 'provider'] as const)(
    'previews DNS through the real Domain controller for %s ingress without retained writes', async scenario => {
    const detail = createDeploymentEnvironmentDetailV1();
    const link = detail.targetLinks[0]!.targetLink;
    if (scenario === 'edge') detail.content.ingress = { kind: 'edgeCaddy', edgeMachineId: 'edge' };
    if (scenario === 'cloudflare') detail.content.ingress = { kind: 'cloudflareTunnel' };
    if (scenario === 'ambiguous') link.members.push({ machineId: 'second', installationId: 'second-installation', state: 'active' });
    const result = { ok: true as const, environmentId: detail.environment.id, dnsHealth: { status: 'up' as const,
        evidence: { v: 1 as const, items: [{ source: { kind: 'alert' as const, label: 'DNS' },
            author: { kind: 'process' as const }, text: 'Target token observed' }] } } };
    const jobs: DeploymentDomainDnsChildRpcV1[] = [];
    const effects: string[] = [];
    const unexpected = async (): Promise<never> => { effects.push('retained-write-or-content'); throw new Error('Unexpected retained mutation'); };
    // Home metadata, opened Artifact storage and child transport are boundaries.
    // Domain input parsing, Environment content decoding, ingress selection and
    // the child schema/projection remain the real owners.
    const host: Parameters<typeof createOwnServerDomainActions>[0] = {
        serverId: detail.environment.serverId, machineId: 'controller', credentials: { token: 'unused', encryption: null },
        serverHttpBaseUrl: 'https://home.test', storage: unexpected, createContent: unexpected,
        persistPreparedContent: unexpected, open: unexpected, headers: unexpected,
        readInstallation: async machineId => { expect(machineId).toBe('edge'); return 'edge-installation'; },
        readReceipt: unexpected,
        readEnvironment: async request => {
            const loaded = await readDeploymentEnvironmentForHost(request, {
                readMetadata: async () => ({ ok: true, environment: detail.environment, targetLinks: [link] }),
                open: async () => ({ artifactId: detail.environment.contentArtifactId,
                    header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.content.name },
                    body: JSON.stringify(detail.content), revision: { headerVersion: 1, bodyVersion: 1 } }),
                assertCurrent: async () => {},
            });
            return { ...loaded, targetLinks: loaded.targetLinks.map(targetLink => ({ targetLink, content: {} })) };
        },
        dispatch: async wire => {
            const job = DeploymentChildRpcV1Schema.parse(wire);
            if (job.kind !== 'domainDns') throw new Error('Draft cannot discover or apply a saved Domain');
            jobs.push(job);
            expect(projectDeploymentChildRoutingV1(job).input).not.toHaveProperty('content');
            return result;
        },
    };
    const input = { mode: 'preview' as const, serverId: detail.environment.serverId, environmentId: detail.environment.id,
        targetLinkId: link.id, expectedRevision: detail.environment.revision + (scenario === 'stale' ? 1 : 0),
        expectedTargetLinkRevision: link.revision, requestKey: 'draft-check',
        content: { hostname: 'draft.example.test', target: scenario === 'provider'
            ? { kind: 'provider' as const } : { service: 'app', containerPort: 8080 } } };
    const controller = createOwnServerDomainActions(host);
    const observed = await controller('deployments.domains.verify', input, {});
    if (scenario === 'direct' || scenario === 'edge') {
        expect(observed).toEqual(result);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({ input, machineId: scenario === 'edge' ? 'edge' : link.members[0]!.machineId,
            installationId: scenario === 'edge' ? 'edge-installation' : link.members[0]!.installationId });
    } else {
        expect(observed).toMatchObject({ ok: false, errorCode: scenario === 'stale' ? 'deployment_conflict'
            : scenario === 'ambiguous' ? 'required_fact_unavailable' : 'native_route_unavailable' });
        expect(jobs).toEqual([]);
    }
    expect(effects).toEqual([]);
});
