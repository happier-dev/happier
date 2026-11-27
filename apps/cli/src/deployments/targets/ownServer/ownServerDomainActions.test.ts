import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { readDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { DeploymentDomainTransitionInputV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { DeploymentDomainHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { createOwnServerDomainActions, prepareOwnServerTeardownDomainReviewedChildren } from './ownServerDomainActions';

const unexpected = async (): Promise<never> => { throw new Error('Provider Domain retirement must not reach this port'); };

describe('Environment Domain retirement', () => {
    it.each([false, true])('reviews another target Link Domain only for whole Environment removal: %s', async removeEnvironment => {
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'runtime-domain', environmentId: 'environment',
            targetLinkId: 'runtime-link', revision: 1, state: 'active', contentArtifactId: 'runtime-domain-content',
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1, provider: true });
        const result = await prepareOwnServerTeardownDomainReviewedChildren({ actionId: 'deployments.teardown', context: {},
            input: { serverId: 'home', environmentId: 'environment', targetLinkId: 'data-link', ...(removeEnvironment ? { removeEnvironment: true } : {}),
                expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'delete-project', reason: 'manual',
                contentArtifactId: 'receipt', contentHeaderVersion: 1, contentBodyVersion: 1 } }, {
            serverId: 'home', readEnvironment: unexpected, open: unexpected,
            // Home storage is the boundary; the real review owner must select the same scope as retirement.
            storage: async actionId => actionId === 'deployments.domains.list'
                ? { ok: true, environmentId: 'environment', revision: 1, domains: [domain], nextCursor: null }
                : unexpected(),
        });
        if (removeEnvironment) expect(result).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        else expect(result).toBeNull();
    });

    it.each([false, true])('leaves another target Link Domain untouched except whole Environment removal: %s', async removeEnvironment => {
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'runtime-domain', environmentId: 'environment',
            targetLinkId: 'runtime-link', revision: 1, state: 'active', contentArtifactId: 'runtime-domain-content',
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1, provider: true });
        const retired: string[] = [];
        const actions = createOwnServerDomainActions({ serverId: 'home', machineId: 'machine',
            credentials: { token: 'fixture', encryption: null }, serverHttpBaseUrl: 'https://home.test',
            // Home storage returns all Environment Domains; retirement owns target selection.
            storage: async actionId => actionId === 'deployments.domains.list'
                ? { ok: true, environmentId: 'environment', revision: 1, domains: [domain], nextCursor: null }
                : unexpected(),
            open: async () => ({ artifactId: domain.contentArtifactId, revision: { headerVersion: 1, bodyVersion: 1 },
                header: { kind: 'deployment-domain.v1', title: 'app.example.test' },
                body: JSON.stringify({ hostname: 'app.example.test', target: { kind: 'provider' } }) }),
            retireProviderDomain: async ({ domain: selected }) => { retired.push(selected.id);
                return { ok: true, environmentId: 'environment', revision: 1, domain: { ...selected, deletedAtMs: 2 } }; },
            dispatch: unexpected, readEnvironment: unexpected,
            readReceipt: unexpected, readInstallation: unexpected, createContent: unexpected,
            persistPreparedContent: unexpected, headers: unexpected });
        expect(await actions.retireEnvironment({ environmentId: 'environment', targetLinkId: 'data-link', ...(removeEnvironment ? { removeEnvironment: true } : {}),
            expectedRevision: 1, requestKey: 'delete-project' }, {})).toBeNull();
        expect(retired).toEqual(removeEnvironment ? [domain.id] : []);
    });

    it('settles a provider removal that only created an approval request as a coded partial failure', async () => {
        const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'domain', environmentId: 'environment',
            targetLinkId: 'link', revision: 1, state: 'active', contentArtifactId: 'domain-content',
            contentHeaderVersion: 1, contentBodyVersion: 1, createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1, provider: true });
        const actions = createOwnServerDomainActions({ serverId: 'home', machineId: 'machine',
            credentials: { token: 'fixture', encryption: null }, serverHttpBaseUrl: 'https://home.test',
            // Home storage is the transport boundary: one page holding the provider Domain.
            storage: async actionId => actionId === 'deployments.domains.list'
                ? { ok: true, environmentId: 'environment', revision: 1, domains: [domain], nextCursor: null }
                : unexpected(),
            open: async () => ({ artifactId: 'domain-content', revision: { headerVersion: 1, bodyVersion: 1 },
                header: { kind: 'deployment-domain.v1', title: 'app.example.test' },
                body: JSON.stringify({ hostname: 'app.example.test', target: { kind: 'provider' } }) }),
            // The provider owner parked its removal behind a person's review instead of settling it.
            retireProviderDomain: async () => ({ kind: 'approval_request_created', artifactId: 'approval', actionId: 'deployments.domains.remove' }),
            dispatch: unexpected, readEnvironment: unexpected, readReceipt: unexpected, readInstallation: unexpected,
            createContent: unexpected, persistPreparedContent: unexpected, headers: unexpected });
        const result = await actions.retireEnvironment({ environmentId: 'environment', expectedRevision: 1, requestKey: 'teardown' }, {});
        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_action_output',
            details: { domainId: 'domain', step: 'removeDomain', partial: true } });
    });
});


it('settles both collector captures before returning the typed private refusal from reviewed Add', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const environment = { ...base, environment: { ...base.environment, telemetryMachineId: 'collector-app' } };
    const link = environment.targetLinks[0]!.targetLink;
    const machine = { machineId: 'machine', installationId: 'installed', dockerEngineId: 'engine' };
    const content = { contentArtifactId: 'collector-domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const serverId = environment.environment.serverId;
    const actionId = DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1;
    const input = { serverId, environmentId: environment.environment.id, targetLinkId: link.id, domainId: 'collector-domain',
        expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision, requestKey: 'reviewed-add', ...content };
    const target = { kind: 'machine' as const, machineId: machine.machineId };
    const envelope = { v: 1 as const, requestId: 'request', target, input };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture', binding: {
        serverIdentityId: serverId, accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
        machineId: machine.machineId, installationId: machine.installationId, environmentId: input.environmentId,
        actionId, deploymentChildRoot: true, requestId: envelope.requestId, accountEncryptionMode: 'plain', target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(actionId, input) } });
    const placements = (['privateOrigin', 'public'] as const).map(listener => ({ desired: true, listener, content, dockerEngineId: 'engine',
        placement: { serverId, accountId: 'owner', environmentId: input.environmentId, targetLinkId: link.id, domainId: input.domainId,
            machineId: machine.machineId, installationId: machine.installationId, requestId: envelope.requestId,
            actionOperationId: 'domain-op', nativeServer: listener } }));
    const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: input.domainId, environmentId: input.environmentId,
        targetLinkId: link.id, state: 'pending', revision: 1, ...content, createdAtMs: 1, updatedAtMs: 1, createdByAccountId: 'owner', placements });
    const calls: unknown[] = [];
    // Network boundaries stand in for the installed child and Home. The native suite
    // verifies the actual observer/signing path and Home verifies proofs on write.
    const transition = vi.spyOn(axios, 'request').mockImplementation(async config => {
        calls.push(DeploymentDomainTransitionInputV1Schema.parse(config?.data).observations.map(({ capture, state, networkExposure }) =>
            ({ listener: capture.listener, state, kind: networkExposure?.kind })));
        return { status: 200, data: { ok: true, environmentId: input.environmentId, revision: 1,
            domain: { ...domain, state: 'warning', revision: 2 } } };
    });
    try {
        const actions = createOwnServerDomainActions({ serverId, machineId: machine.machineId, serverHttpBaseUrl: 'https://home.test',
            credentials: { token: 'fixture', encryption: null }, readEnvironment: async () => environment,
            readTelemetryCollectorPlacement: async () => ({ kind: 'ready', ...machine, deploymentId: 'collector-release' }),
            storage: async () => ({ ok: true, environmentId: input.environmentId, revision: 1, domain }),
            open: async () => ({ artifactId: content.contentArtifactId, header: { kind: 'deployment-domain.v1', title: 'Collector' },
                revision: { headerVersion: 1, bodyVersion: 1 }, body: JSON.stringify({ hostname: 'collector.example.test', target: { kind: 'telemetry' } }) }),
            readReceipt: unexpected, readInstallation: unexpected, createContent: unexpected, persistPreparedContent: unexpected,
            headers: async () => ({}),
            async dispatch(job) {
                if (job.kind === 'domainDiscover') return { ...machine, privateNetworks: [], replicas: [],
                    caddy: { status: 'ready', containerId: 'caddy', containerName: 'caddy', adminSocketPath: '/run/caddy.sock', networkNames: [],
                        servers: [{ serverId: 'privateOrigin', listen: [':8080'], tls: false, automaticHttpsDisabled: true, endpoints: [] },
                            { serverId: 'public', listen: [':443'], tls: true, automaticHttpsDisabled: false,
                                endpoints: [{ hostAddress: '0.0.0.0', hostPort: 443, containerPort: 443 }] }] } };
                if (job.kind !== 'domain') return unexpected();
                const proof = { version: 1, algorithm: 'ed25519', signature: Buffer.alloc(64).toString('base64url') };
                return job.capture.listener === 'privateOrigin' ? { capture: job.capture, proof, state: 'warning',
                    networkExposure: { kind: 'unavailable', reason: 'private_scope_unenforceable', requiredFact: 'reachabilityPosture' } }
                    : { capture: job.capture, proof, state: 'active',
                        networkExposure: { kind: 'ready', listener: 'public', localOrigin: true, fallback: false, listeners: [] } };
            },
        });
        const result = await actions(actionId, input, { externalActionExecutionAuthorization: authorization,
            originalActionEnvelope: envelope, operationAcceptance: { operationId: 'domain-op', accept() {} } });
        expect(calls).toEqual([[{ listener: 'privateOrigin', state: 'warning', kind: 'unavailable' },
            { listener: 'public', state: 'active', kind: 'ready' }]]);
        expect(result).toMatchObject({ ok: false, errorCode: 'private_scope_unenforceable', details: { requiredFact: 'reachabilityPosture' } });
        expect(readDeploymentFailureRecoveryV1('private_scope_unenforceable', 'details' in result ? result.details : undefined)).toMatchObject({
            remedy: expect.stringContaining('native interface'), nextAction: { destination: 'domains' },
        });
    } finally { transition.mockRestore(); }
});
