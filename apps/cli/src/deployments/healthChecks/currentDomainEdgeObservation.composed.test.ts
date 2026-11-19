import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { HealthCheckDefinitionV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDaemonDeploymentActionDeps } from '../createDaemonDeploymentActionDeps';
import { createDaemonHostResourceRead } from '@/rpc/handlers/daemonHostResourceRead';
import { finiteHealthCheckResult } from './finiteHealthCheckResult';

describe('current Domain edge through the installed Action and Resource watch', () => {
    it('withdraws a refused Domain read to unknown on the open Resource', async () => {
        const mounted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
        const signal = new AbortController();
        let watch: Awaited<ReturnType<ReturnType<typeof createDaemonHostResourceRead>['observe']>> | undefined;
        try {
            const observer = { machineId: 'machine-a', installationId: 'installation-a' };
            const environment = createDeploymentEnvironmentHeaderV1({ ingress: { kind: 'edgeCaddy', edgeMachineId: 'machine-edge' } });
            const targetLink = createDeploymentTargetLinkHeaderV1({ machines: ['machine-runtime'],
                members: [{ machineId: 'machine-runtime', installationId: 'installation-runtime', state: 'active' }] });
            const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: environment.id,
                targetLinkId: targetLink.id, revision: 1, state: 'active', contentArtifactId: 'artifact-domain',
                contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'account-owner',
                createdAtMs: 1000, updatedAtMs: 1000 });
            const check = HealthCheckDefinitionV1Schema.parse({ checkId: 'http',
                kind: { pluginId: 'happier.machine.services', localId: 'http' },
                binding: { kind: 'domain', domainId: domain.id, targetLinkId: targetLink.id, condition: 'domain_probe_failed' },
                config: {}, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 });
            const proof = mounted.registry.currentDomainEdgeObservation;
            if (!proof) throw new Error('The installed registry did not own current Domain observation');
            const publish = () => proof.publish({ sourceInstanceId: 'saved', sourceRevision: '1', checkId: check.checkId, kind: 'http',
                caller: { pluginId: 'happier.machine.services', machineId: observer.machineId, materializationId: 'installed' },
                occurrenceId: 'occurrence', check, environment, targetLink, domain, observer,
                result: finiteHealthCheckResult({ observer, vantage: 'outside' }, 'http', 1000, 995, 'up') });
            publish();
            const publishCertificate = () => proof.publish({ sourceInstanceId: 'saved', sourceRevision: '1', checkId: 'certificate', kind: 'certificate',
                caller: { pluginId: 'happier.machine.services', machineId: observer.machineId, materializationId: 'installed' },
                occurrenceId: 'occurrence', check: HealthCheckDefinitionV1Schema.parse({ ...check, checkId: 'certificate',
                    kind: { pluginId: 'happier.machine.services', localId: 'certificate' } }),
                environment, targetLink, domain, observer, tlsKind: 'custom',
                result: finiteHealthCheckResult({ observer, vantage: 'outside' }, 'certificate', 2000, 1995, 'up',
                    { notBefore: 0, notAfter: 3000 }) });
            publishCertificate();
            let domainRefusal: 'deployment_unavailable' | 'deployment_access_denied' | null = null;
            let currentTargetLink = targetLink;
            let currentDomain = domain;
            vi.spyOn(axios, 'request').mockImplementation(async request => {
                const path = new URL(String(request.url)).pathname;
                if (path === `/v1/deployments/environments/${environment.id}`) return { status: 200,
                    data: { ok: true, environment, targetLinks: [currentTargetLink] } };
                if (path === `/v1/deployments/environments/${environment.id}/domains/${domain.id}`) return { status: 200,
                    data: domainRefusal ? { ok: false, error: domainRefusal }
                        : { ok: true, environmentId: environment.id, revision: environment.revision, domain: currentDomain } };
                throw new Error(`Unexpected Home request ${path}`);
            });
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`;
            const deps = createDaemonDeploymentActionDeps({ credentials: { token, encryption: null },
                serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: observer.machineId,
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                runtime: { async acquire() { throw new Error('A current read cannot acquire native deployment effects'); } } });
            vi.spyOn(Date, 'now').mockReturnValue(2000);
            const executor = createActionExecutor(deps);
            const resource = createDaemonHostResourceRead({ readAccountId: () => 'account-owner',
                resolveActionExecutor: async () => executor });
            const reference = { hostRead: 'deployments.health.edge' as const,
                input: { serverId: 'home', machineId: observer.machineId, environmentId: environment.id,
                    targetLinkId: targetLink.id, domainIds: [domain.id] } };
            const context = { signal: signal.signal, localActionContext: { surface: 'cli' as const,
                authority: 'present_user' as const, serverId: 'home', runtimeAccountId: 'account-owner' } };
            let changed = (_digest: string) => {};
            const invalidated = new Promise<string>(resolve => { changed = resolve; });
            const errors: unknown[] = [];
            watch = await resource.observe(reference, observer.machineId, context, signal.signal, changed, error => { errors.push(error); });
            expect((await resource.read(reference, observer.machineId, context)).value)
                .toMatchObject({ ok: true, observation: { status: 'up', machineId: 'machine-edge' },
                    domainHealth: [{ domainId: domain.id, facts: { certificate: { state: 'expiresSoon', expiresAt: 3000 },
                        needsYou: { cause: 'certificate', vantage: 'outside' } } }] });
            domainRefusal = 'deployment_unavailable';
            const withdrawn = await resource.read(reference, observer.machineId, context);
            expect(withdrawn.value).toMatchObject({ ok: true, observation: null, domainHealth: [] });
            expect(await invalidated).toBe(withdrawn.digest);
            expect(proof.read(environment.id, targetLink.id)).toBeNull();
            expect(errors).toEqual([]);
            await watch.dispose();
            watch = undefined;
            domainRefusal = null;
            publishCertificate();
            currentTargetLink = { ...targetLink, revision: targetLink.revision + 1 };
            expect((await resource.read(reference, observer.machineId, context)).value)
                .toMatchObject({ ok: true, observation: null, domainHealth: [{ domainId: domain.id,
                    facts: { availability: 'not_checked', certificate: { state: 'not_checked' }, needsYou: null }, observations: [] }] });
            currentTargetLink = targetLink;
            publishCertificate();
            currentDomain = { ...domain, revision: domain.revision + 1 };
            expect((await resource.read(reference, observer.machineId, context)).value)
                .toMatchObject({ ok: true, observation: null, domainHealth: [{ domainId: domain.id,
                    domainRevision: currentDomain.revision, facts: { availability: 'not_checked' }, observations: [] }] });
            currentDomain = domain;
            publish();
            domainRefusal = 'deployment_access_denied';
            await expect(resource.read(reference, observer.machineId, context))
                .rejects.toMatchObject({ code: 'deployment_access_denied' });
            expect(proof.read(environment.id, targetLink.id)).toBeNull();
        } finally { signal.abort(); await watch?.dispose(); vi.restoreAllMocks(); await mounted.dispose(); }
    });
});
