import { expect, it } from 'vitest';
import { TeamCredentialResourceCatalogEntryV1Schema, TeamCredentialSourceBindingV1Schema } from '@happier-dev/protocol/teams';
import { DaemonProviderModelProjectionRequestV1Schema, type DaemonProviderModelProjectionRequestV1 } from '@happier-dev/protocol/rpc/providers';

import type { Fastify } from '@/app/api/types';
import type { TeamCredentialCatalogReadinessProjection } from './brokerReadiness';
import { projectTeamCredentialCatalogModels } from './catalogModels';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { PrivateLabelStoredV1Schema, projectPrivateLabelForRecipientV1 } from '@happier-dev/protocol/crypto/privateLabelV1';

const SOURCE_LABEL = projectPrivateLabelForRecipientV1({
    stored: PrivateLabelStoredV1Schema.parse({ content: { t: 'plain', v: 'Source' }, recipients: [] }),
    recipientAccountId: 'recipient',
});

it.each(['storage_failure', 'application_mismatch', 'saved_provider_purpose'] as const)('preserves the source RPC failure reason (%s)', async failure => {
    const providerPurpose = { consumer: { pluginId: 'example.provider.source', localId: 'source' }, purpose: 'models' };
    const source = TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: 'connected_account', credentialIncarnation: 'incarnation',
        target: { kind: 'account', account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'source' } },
        ...(failure === 'saved_provider_purpose' ? { providerPurpose } : {}) });
    const application = { agentTargetKey: 'agent:happier.agent.codex/codex',
        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' as const };
    const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'resource', teamId: 'team', displayName: SOURCE_LABEL,
        resourceRevision: 4, readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
        directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', providerModels: [],
        sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } } });
    const result: TeamCredentialCatalogReadinessProjection = { ok: true, page: { resources: [resource], nextCursor: null },
        brokerReadinessRequests: [], projectionRequests: [{ resourceId: resource.id, teamId: resource.teamId, resourceRevision: 4,
            custodianAccountId: 'custodian', brokerMachineId: 'machine', brokerPoolId: null, source, allowedModelIds: null,
            deliveryMode: 'brokered', directMaterialReferences: [] }],
        brokerReadiness: { unavailable: new Map(), poolSnapshots: new Map(), presenceByAccount: new Map() } };
    let requests = 0;
    let requestedSource: unknown;
    // RPC is the network boundary; the real projector must not turn a rejected
    // observation into an available empty catalog. No database is opened.
    const app: Pick<Fastify, 'forwardRpcForUser'> = { forwardRpcForUser: async request => {
        requests++;
        requestedSource = request.params;
        if (failure !== 'storage_failure') return { ok: true, result: {
            status: 'error', error: createProviderErrorV1('provider_incompatible_with_agent'),
        } };
        throw Object.assign(new Error('Synthetic missing storage column'), { code: 'P2022' });
    } };
    expect(await projectTeamCredentialCatalogModels(app, result, application)).toMatchObject({ resources: [{
        providerModels: [], readiness: { kind: 'broker_unavailable', reason: failure === 'storage_failure' ? 'projection_unavailable' : 'incompatible' },
        recoveryAction: failure === 'storage_failure' ? 'retry' : 'source_owner_action',
    }] });
    expect(requests).toBe(1);
    if (failure === 'saved_provider_purpose') {
        expect(requestedSource).toMatchObject({ connectedAccountSourcePurpose: providerPurpose, application });
    }
});

it.each([0, 1, 2])('keeps Direct declaration discovery separate from broker observation with %s material references', async count => {
    const source = TeamCredentialSourceBindingV1Schema.parse({ v: 1, kind: 'connected_account', credentialIncarnation: 'incarnation',
        target: { kind: 'account', account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'source' } } });
    const application = { agentTargetKey: 'agent:happier.agent.codex/codex',
        implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
        endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' as const };
    const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'resource', teamId: 'team', displayName: SOURCE_LABEL,
        resourceRevision: 1, readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: true,
        directMaterialState: count ? 'current' : 'never_delivered', sessionUsePolicy: 'personal_allowed', providerModels: [],
        sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } } });
    const base = { resourceId: resource.id, teamId: resource.teamId, resourceRevision: 1,
        custodianAccountId: 'custodian', brokerMachineId: 'machine', brokerPoolId: null, source, allowedModelIds: null };
    const result: TeamCredentialCatalogReadinessProjection = { ok: true, page: { resources: [resource], nextCursor: null },
        brokerReadinessRequests: [], projectionRequests: [
            { ...base, deliveryMode: 'brokered', directMaterialReferences: [] },
            { ...base, deliveryMode: 'direct', directMaterialReferences: Array.from({ length: count }, (_, index) => ({
                sourceMemberKey: `member-${index}`, sourceVersion: `version-${index}`,
            })) },
        ], brokerReadiness: { unavailable: new Map(), poolSnapshots: new Map(),
            presenceByAccount: new Map([['custodian', { state: 'known', machineIds: new Set(['machine']) }]]) } };
    const requests: DaemonProviderModelProjectionRequestV1[] = [];
    // The daemon RPC is the network boundary. Home's route/dedupe owner and
    // strict request/recipient DTO parsers run unchanged beneath it.
    const app: Pick<Fastify, 'forwardRpcForUser'> = { forwardRpcForUser: async request => {
        expect(request.userId).toBe('custodian');
        requests.push(DaemonProviderModelProjectionRequestV1Schema.parse(request.params));
        return { ok: false, error: 'projection_unavailable' };
    } };
    const projected = await projectTeamCredentialCatalogModels(app, result, application);
    expect(projected.resources[0]).toMatchObject({ providerModels: [],
        readiness: count ? { kind: 'available' } : { kind: 'broker_unavailable', reason: 'projection_unavailable' },
    });
    expect(requests).toHaveLength(2);
    expect(requests.filter(request => request.includeDirectMaterialization === true)).toHaveLength(1);
    expect(requests.filter(request => request.includeDirectMaterialization === undefined)).toHaveLength(1);
});
