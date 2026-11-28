import { createHash, randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { expect } from 'vitest';
import { stubUndiciFetch } from '@/testkit/http/stubUndiciFetch';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { DeploymentEnvironmentContentV1Schema, DeploymentTargetLinkContentV1Schema, DeploymentProviderTeardownContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec, projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { bindPresentUserActionConfirmationV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionResponseV2, sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { DEPLOYMENT_TEARDOWN_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { projectDeploymentReviewedCandidateV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { DeploymentEnvironmentCreateResultV1Schema, DeploymentReceiptGetResultV1Schema, DeploymentReceiptListResultV1Schema, DeploymentReceiptResultV1Schema, DeploymentTargetLinkResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { ProjectSourcesCreateOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { computeCanonicalDomainSeparatedDigest, type ActionExecuteResult } from '@happier-dev/protocol';
import { TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1, computeTeamCredentialConnectedAccountSourceVersionV1,
    computeTeamCredentialSourceMemberKeyV1, createTeamCredentialDirectMaterialStoredV1 } from '@happier-dev/protocol/teams';
import { mutateQualifiedConnectedAccountCredentialV4 } from '@/api/client/qualifiedConnectedAccountApi';
import type { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { encodeStoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { actionIds } from '../../../../packages/plugins/deployment-railway/src/actions';
import { manifest as railwayDataManifest } from '../../../../packages/plugins/deployment-railway/src/manifest';
import { PLUGIN_MANIFEST as railwayAccountManifest } from '../../../../packages/plugins/machine-railway/src/manifest';
import { mutateQualifiedConnectedServiceCredential } from '../../../server/sources/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository';
import { createServiceAccountTokenIdentityFields } from '../../../server/sources/app/api/routes/connect/qualifiedConnectedAccounts/identity';
import { upsertTeamCredentialRecipientMaterialInTx } from '../../../server/sources/app/teams/credentials/recipientMaterial';
import { createSignedAccountContentBinding } from '../../../server/sources/testkit/accountEncryption';
import type { DeploymentSocketHomeFixture } from '../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { db } from '../../../server/sources/storage/db';
import { inTx } from '../../../server/sources/storage/inTx';

type Invoke = (name: string, input: unknown) => Promise<ActionExecuteResult>;
type Artifacts = Pick<ReturnType<typeof createCredentialedAccountArtifactStore>, 'create' | 'read'>;

async function shareRailwayCredential(home: DeploymentSocketHomeFixture, account: QualifiedConnectedAccountRef, token: string) {
    if (!home.encryption) throw new Error('The Team recipient requires E2EE material');
    const keys = nacl.box.keyPair();
    const custodian = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
    const team = await db.team.create({ data: { name: 'Billing operators' } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId: custodian.id, role: 'owner' } });
    const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: home.accountId, role: 'member' } });
    const authenticationModeId = 'token';
    const contributionContractVersion = 'railway-token-fixture';
    const credential = { v: 1 as const, values: { token } };
    const directExportContract = TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1;
    const written = await mutateQualifiedConnectedServiceCredential({
        accountId: custodian.id, ref: account, authenticationModeId, expectedCredentialRevision: null, directExportContract,
        contributionContractVersion, metadata: { scopes: [] },
        content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee',
            material: { type: 'dataKey', machineKey: keys.secretKey, publicKey: keys.publicKey }, payload: credential, randomBytes: nacl.randomBytes }),
    });
    if (written.status !== 'written') throw new Error(`Team Railway credential refused: ${written.status}`);
    const row = await db.serviceAccountToken.findFirstOrThrow({ where: { accountId: custodian.id,
        ...createServiceAccountTokenIdentityFields({ ref: account, authenticationModeId }) } });
    const resource = await db.teamCredentialResource.create({ data: { teamId: team.id, custodianAccountId: custodian.id,
        displayName: 'Shared Billing warehouse', disclosureCeiling: 'direct_allowed', sessionUsePolicy: 'personal_allowed',
        sourceBindingJson: JSON.stringify({ v: 1, kind: 'connected_account', target: { kind: 'account', account }, credentialIncarnation: row.id }),
        memberGrants: { create: { teamMembershipId: member.id, deliveryMode: 'direct' } },
    } });
    const sourceMember = { kind: 'connected_account' as const, service: account.service, connectedAccountId: account.accountId };
    const sourceVersion = computeTeamCredentialConnectedAccountSourceVersionV1({ sourceAccountId: account.accountId,
        credentialIncarnation: row.id, sourceMember, credentialRevision: written.credentialRevision, configurationRevision: null,
        authenticationModeId, contributionContractVersion: computeCanonicalDomainSeparatedDigest(directExportContract, [contributionContractVersion]) });
    const recipientContentPublicKey = home.encryption.publicKey;
    const stored = createTeamCredentialDirectMaterialStoredV1({ recipientMode: 'e2ee', recipientContentPublicKey,
        randomBytes: nacl.randomBytes, payload: { v: 1, domain: 'happier.team-credential-direct-material', homeServerIdentityId: home.serverId,
            teamId: team.id, resourceId: resource.id, resourceRevision: resource.revision, recipientAccountId: home.accountId,
            sourceMember, sourceVersion, material: { kind: 'qualified_connected_account', credential, configuration: null, authenticationModeId } },
    });
    expect(await inTx(tx => upsertTeamCredentialRecipientMaterialInTx(tx, { actorAccountId: custodian.id, resourceId: resource.id,
        recipientAccountId: home.accountId, sourceMemberKey: computeTeamCredentialSourceMemberKeyV1(sourceMember), sourceVersion,
        recipientMode: 'e2ee', recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipientContentPublicKey),
        stored, expectedResourceRevision: resource.revision, expectedStoredSourceVersion: null, expectedPublishedSourceVersion: null,
    }))).toMatchObject({ ok: true });
    return { kind: 'team' as const, teamId: team.id, purpose: {
        consumer: { pluginId: railwayDataManifest.id, localId: actionIds('postgresql').link }, purpose: 'cloud-api' },
        selection: { source: 'team_resource' as const, resourceId: resource.id, deliveryMode: 'direct' as const, disclosedMember: account } };
}

export async function runRailwayVolumeRemovalCoverage({ surface, home, artifacts, invoke, settlePublicApproval, withUnavailableCredentialRead }: Readonly<{
    surface: 'browser' | 'signed';
    home: DeploymentSocketHomeFixture;
    artifacts: Artifacts;
    invoke: Invoke;
    settlePublicApproval(invoke: Invoke, pending: ActionExecuteResult): Promise<ActionExecuteResult>;
    withUnavailableCredentialRead(read: () => Promise<ActionExecuteResult>): Promise<ActionExecuteResult>;
}>) {
    const material = home.encryption;
    if (home.encryptionMode !== 'e2ee' || !material) throw new Error('Railway teardown requires E2EE');
    const actionId = DEPLOYMENT_TEARDOWN_ACTION_ID_V1;
    const target = { kind: 'machine' as const, machineId: home.machineId };
    const post = (path: string, body: unknown) => fetch(`${home.baseUrl}${path}`, { method: 'POST',
        headers: { Authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
    const pressDelete = async (input: unknown, requestId: string, confirmed?: Readonly<{
        candidate: NonNullable<ReturnType<typeof projectDeploymentReviewedCandidateV1>>;
        originalAuthorizationToken: string;
        digest: string;
        reviewedInput: unknown;
    }>) => {
        const binding = { serverIdentityId: home.serverId, accountId: home.accountId, actionId, requestId, target,
            authentication: { kind: 'account' as const, tokenEpoch: 0 } };
        const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
            binding, input, material, randomBytes: nacl.randomBytes });
        const minted = await post(bindExternalActionExecutionAuthorizationHttpPathV1(actionId), {
            v: 1, machineId: home.machineId, envelope,
            ...(confirmed ? { deploymentReview: { candidate: confirmed.candidate, originalAuthorizationToken: confirmed.originalAuthorizationToken } } : {}),
        });
        const mintPayload: unknown = await minted.json();
        if (minted.status === 403) {
            return { execution: null, authorizationToken: null, authorizationRefusal: mintPayload };
        }
        expect(minted.status, JSON.stringify(minted.ok ? null : mintPayload)).toBe(200);
        const root = ExternalActionExecutionAuthorizationV1Schema.parse(mintPayload);
        const context = { surface: 'ui' as const, actionCaller: { kind: 'host' as const }, authority: 'present_user' as const,
            runtimeAccountId: home.accountId, serverId: home.serverId, serverIdentityId: home.serverId,
            actionRequestId: requestId, externalActionTarget: target };
        const confirmation = bindPresentUserActionConfirmationV1(actionId, input, context,
            confirmed?.digest, confirmed?.reviewedInput).presentUserConfirmation;
        const authorization = sealExternalActionRequesterAccountContextV1({ authorization: root,
            purpose: { kind: 'external_action' }, installationPublicKey: home.keys.publicKey, randomBytes: nacl.randomBytes,
            credentials: encodeStoredCredentials({ token: home.token, encryption: material }),
            invocation: { surface: 'ui', caller: context.actionCaller, authority: context.authority,
                ...(confirmation ? { presentUserConfirmation: confirmation } : {}) },
        });
        const response = await post(`/v1/actions/${actionId}`, { v: 1, machineId: home.machineId, envelope,
            executionAuthorization: authorization });
        const payload: unknown = await response.json();
        expect(response.status, JSON.stringify(response.ok ? null : payload)).toBe(200);
        const execution = openExternalActionResponseV2({ envelope: payload, binding, request: envelope, material });
        if (!execution) throw new Error('Expected the bound E2EE Delete response');
        return { execution, authorizationToken: root.token };
    };
    const descriptor = railwayAccountManifest.contributes.connectedAccountDescriptors?.[0];
    if (!descriptor) throw new Error('Railway Account descriptor is required');
    const credentialRef = { service: { pluginId: railwayAccountManifest.id, localId: descriptor.id }, accountId: randomUUID() };
    const token = randomUUID();
    await runWithServerHttpBaseUrl(home.baseUrl, () => mutateQualifiedConnectedAccountCredentialV4({ token: home.token,
        mutation: { ref: credentialRef, authenticationModeId: 'token', expectedCredentialRevision: null,
            content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee', material,
                payload: { v: 1, values: { token } }, randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) }),
            metadata: { displayName: 'Railway fixture Account', scopes: [] },
        } }));
    const approvedArtifacts = new Set<string>();
    const settle = async (result: ActionExecuteResult) => settlePublicApproval((name, input) => {
        if (name === 'approval.request.decide') {
            const { artifactId } = getActionSpec('approval.request.decide').inputSchema.parse(input);
            if (approvedArtifacts.has(artifactId)) throw new Error('A signed Action requested the same approval again after the person decided');
            approvedArtifacts.add(artifactId);
        }
        return invoke(name, input);
    }, result);
    const resultOf = async (name: string, input: unknown) => {
        const result = await settle(await invoke(name, input));
        if (!result.ok) throw new Error(`${name} refused: ${JSON.stringify({ errorCode: result.errorCode, failureCause: result.failureCause })}`);
        return result.result;
    };
    const save = async (kind: string, body: unknown) => {
        const artifact = await artifacts.create({ header: { kind, title: 'Billing warehouse' }, body: JSON.stringify(body) });
        return { contentArtifactId: artifact.artifactId, contentHeaderVersion: artifact.revision.headerVersion,
            contentBodyVersion: artifact.revision.bodyVersion };
    };
    const sourceResponse = await fetch(`${home.baseUrl}/v1/projects/sources`, {
        method: 'POST', headers: { Authorization: `Bearer ${home.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: home.serverId, requestKey: randomUUID(), name: 'Billing warehouse', audience: [] }),
    });
    const source = ProjectSourcesCreateOutputV1Schema.parse(await sourceResponse.json());
    if (!source.ok) throw new Error(`Railway fixture Source refused: ${source.error}`);

    const projectId = 'billing-project';
    const environmentId = 'billing-production';
    const serviceId = 'postgres-service';
    const otherEnvironmentId = 'billing-staging';
    const volumeId = 'postgres-volume';
    const unrelatedVolumeId = 'redis-volume';
    const volumeUrl = `https://railway.com/project/${projectId}/volume/${volumeId}?environmentId=${otherEnvironmentId}`;
    const document = 'services:\n  web:\n    image: nginx:alpine\n';
    const pageInfo = { hasNextPage: false, endCursor: null };
    const instance = (id: string, environmentId: string, serviceId: string, volumeId: string) =>
        ({ node: { id, environmentId, serviceId, volumeId, deletedAt: null, isPendingDeletion: false } });
    const writes: { kind: 'service' | 'volume'; id: string; environmentId?: string }[] = [];
    let railwayRequests = 0;
    let shared = false;
    let inventoryUnavailable = false;
    let targetHasVolume = true;
    let servicePresent = true;
    let loseVolumeAcknowledgement = false;
    const nativeFetch = globalThis.fetch;
    const providerHttp = stubUndiciFetch(async (url: string | URL | Request, init?: RequestInit) => {
        const parsed = new URL(typeof url === 'object' && 'url' in url ? url.url : String(url));
        if (parsed.origin !== 'https://backboard.railway.com') return nativeFetch(url, init);
        railwayRequests++;
        expect(parsed.pathname).toBe('/graphql/v2');
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('authorization') === `Bearer ${token}`).toBe(true);
        if (!(init?.body instanceof Uint8Array)) throw new Error('Railway requests require a JSON body');
        const { query, variables } = JSON.parse(new TextDecoder().decode(init.body));
        if (query.includes('volumeInstances')) {
            expect(variables).toMatchObject({ projectId });
            if (inventoryUnavailable) return Response.json({ errors: [{ message: 'Volume inventory unavailable' }] }, { status: 503 });
            const environment = (id: string, edges: ReturnType<typeof instance>[]) => ({ node: { id, volumeInstances: { edges, pageInfo } } });
            return Response.json({ data: { project: { id: projectId, environments: { pageInfo, edges: [
                environment(environmentId, [...(servicePresent && targetHasVolume ? [instance('postgres-production', environmentId, serviceId, volumeId)] : []),
                    instance('redis-production', environmentId, 'redis-service', unrelatedVolumeId)]),
                environment(otherEnvironmentId, shared ? [instance('postgres-staging', otherEnvironmentId, serviceId, volumeId)] : []),
            ] } } } });
        }
        if (query.includes('serviceDelete')) {
            writes.push({ kind: 'service', id: variables.id, environmentId: variables.environmentId });
            servicePresent = false;
            return Response.json({ data: { serviceDelete: true } });
        }
        if (query.includes('volumeDelete')) {
            writes.push({ kind: 'volume', id: variables.volumeId });
            if (loseVolumeAcknowledgement) throw new TypeError('Railway volume response was lost');
            return Response.json({ data: { volumeDelete: true } });
        }
        if (query.includes('serviceInstances')) {
            expect(variables).toMatchObject({ projectId, environmentId });
            return Response.json({ data: { environment: { id: environmentId, projectId, serviceInstances: {
                edges: servicePresent ? [{ node: { serviceId, serviceName: 'Billing PostgreSQL', deletedAt: null } }] : [], pageInfo,
            } } } });
        }
        throw new Error('Unexpected Railway GraphQL operation');
    });
    try {
        for (const scenario of [
            { name: 'browser carried review', before: false, after: false, unavailable: false, browser: true,
                preview: { kind: 'removed' }, observation: { kind: 'removed' } },
            { name: 'exclusive', before: false, after: false, unavailable: false,
                preview: { kind: 'removed' }, observation: { kind: 'removed' } },
            { name: 'shared', before: true, after: true, unavailable: false,
                preview: { kind: 'kept', otherEnvironments: 1, url: volumeUrl }, observation: { kind: 'kept', otherEnvironments: 1, url: volumeUrl } },
            { name: 'unavailable', before: false, after: false, unavailable: true,
                preview: { kind: 'unchecked' }, observation: { kind: 'kept-unchecked' } },
            { name: 'only unrelated volume', before: false, after: false, unavailable: false },
            { name: 'credential unavailable during review', before: false, after: false, unavailable: false,
                preview: { kind: 'unchecked' }, observation: { kind: 'removed' } },
            { name: 'changed after review', before: false, after: true, unavailable: false,
                preview: { kind: 'removed' }, observation: { kind: 'kept', otherEnvironments: 1, url: volumeUrl } },
            { name: 'kept at review, alone at execution', before: true, after: false, unavailable: false,
                preview: { kind: 'kept', otherEnvironments: 1, url: volumeUrl }, observation: { kind: 'removed' } },
            { name: 'Team-direct exclusive', before: false, after: false, unavailable: false, team: true,
                preview: { kind: 'unchecked' }, observation: { kind: 'removed' } },
            { name: 'Team-direct shared', before: true, after: true, unavailable: false, team: true,
                preview: { kind: 'unchecked' }, observation: { kind: 'kept', otherEnvironments: 1, url: volumeUrl } },
            { name: 'volume acknowledgement lost', before: false, after: false, unavailable: false,
                preview: { kind: 'removed' } },
        ] as const) {
            if (('browser' in scenario) !== (surface === 'browser')) continue;
            writes.length = 0;
            railwayRequests = 0;
            shared = scenario.before;
            inventoryUnavailable = scenario.unavailable;
            targetHasVolume = scenario.name !== 'only unrelated volume';
            servicePresent = true;
            loseVolumeAcknowledgement = scenario.name === 'volume acknowledgement lost';
            const content = DeploymentEnvironmentContentV1Schema.parse({ name: `Billing warehouse ${scenario.name}`,
                retainPreviousDeployments: 0, definition: { kind: 'stored', contentRevision: 1, document,
                    profiles: [], services: ['web'], composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}` }, bindings: [] });
            const created = DeploymentEnvironmentCreateResultV1Schema.parse(await resultOf('deployments.environments.create', {
                serverId: home.serverId, projectSourceId: source.source.id, requestKey: randomUUID(),
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: home.machineId,
                ...await save(DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, content),
            }));
            if (!created.ok) throw new Error(`Railway fixture Environment refused: ${created.error}`);
            const address = { serverId: home.serverId, environmentId: created.environmentId };
            const contribution = { pluginId: railwayDataManifest.id, localId: 'postgresql' };
            const team = 'team' in scenario;
            const purpose = { consumer: { pluginId: railwayDataManifest.id, localId: actionIds('postgresql').link }, purpose: 'cloud-api' };
            const credentialPrincipal = team ? await shareRailwayCredential(home, { ...credentialRef, accountId: randomUUID() }, token)
                : { kind: 'account', accountId: home.accountId, purpose, target: { kind: 'account', account: credentialRef } };
            const linkContent = DeploymentTargetLinkContentV1Schema.parse({
                providerResourceOrigin: 'created',
                providerIdentity: { providerAccountId: projectId, providerResourceId: serviceId, providerEnvironment: environmentId },
                providerEnvironment: { kind: 'native', selection: { projectId, environmentId, serviceId } },
                credentialPrincipal,
            });
            const linked = DeploymentTargetLinkResultV1Schema.parse(await resultOf('deployments.targets.link', {
                ...address, expectedRevision: created.revision, requestKey: randomUUID(), targetId: 'postgresql',
                role: 'data', targetKind: 'railway-postgresql', source: { kind: 'plugin', contribution }, machines: [],
                ...await save(DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, linkContent),
            }));
            if (!linked.ok || !('targetLinkId' in linked)) throw new Error(`Railway fixture target link refused: ${JSON.stringify(linked)}`);
            const removal = { ...address, targetLinkId: linked.targetLinkId, requestKey: randomUUID(), reason: 'manual', providerRemoval: 'delete' };
            if ('browser' in scenario) {
                const { execution: first, authorizationToken } = await pressDelete(removal, randomUUID());
                expect(first).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required',
                    details: { review: { preview: { deploymentReview: { removal: { volumeRemoval: scenario.preview } } } },
                        reviewDigest: expect.any(String) } });
                expect(writes).toEqual([]);
                if (!first || first.ok || !authorizationToken) throw new Error('Expected a carried review');
                const details = readRecord(first.details);
                const reviewedInput = readRecord(details.review).actionArgs;
                const candidate = projectDeploymentReviewedCandidateV1(reviewedInput);
                if (!candidate || typeof details.reviewDigest !== 'string') throw new Error('Expected a bound Delete review');
                const carried = { candidate, reviewedInput, digest: details.reviewDigest, originalAuthorizationToken: authorizationToken };
                const { execution: changed } = await pressDelete(removal, randomUUID(), {
                    ...carried, digest: (carried.digest.startsWith('A') ? 'B' : 'A') + carried.digest.slice(1),
                });
                expect(changed).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required',
                    details: { reviewDigest: carried.digest } });
                expect(writes).toEqual([]);

                const { execution: confirmed } = await pressDelete(removal, randomUUID(), carried);
                expect(confirmed, JSON.stringify(confirmed)).toMatchObject({ ok: true, result: { ok: true, state: 'succeeded' } });
                expect(writes).toEqual([{ kind: 'service', id: serviceId, environmentId }, { kind: 'volume', id: volumeId }]);
                const writeCount = writes.length;
                const repeatRequestId = randomUUID();
                const { execution: repeated, authorizationRefusal } = await pressDelete(removal, repeatRequestId, carried);
                expect(writes).toHaveLength(writeCount);
                if (repeated === null) {
                    expect(authorizationRefusal).toMatchObject({ error: 'credential_scope_denied', requestId: repeatRequestId,
                        details: { deploymentReview: 'stale' } });
                } else if (repeated.ok) {
                    expect(repeated).toEqual(confirmed);
                } else {
                    expect(repeated.errorCode).toBe('action_operation_unavailable');
                }
                continue;
            }
            const review = () => invoke('deployments.teardown', removal);
            const credentialUnavailable = scenario.name === 'credential unavailable during review';
            const pending = credentialUnavailable ? await withUnavailableCredentialRead(review) : await review();
            if (credentialUnavailable) expect(railwayRequests).toBe(0);
            if (!pending.ok) throw new Error(`Railway signed teardown refused: ${JSON.stringify({ errorCode: pending.errorCode, failureCause: pending.failureCause })}`);
            const approval = ActionApprovalRequestCreatedResultSchema.parse(pending.result);
            const open = await resultOf('approval.request.get', { artifactId: approval.artifactId });
            expect(open).toMatchObject({ request: { status: 'open', actionId: 'deployments.teardown' } });
            const previewAssertion = expect.soft(open, `${scenario.name} (${railwayRequests} Railway preview requests)`);
            if ('preview' in scenario) previewAssertion.toHaveProperty('request.preview.deploymentReview.removal.volumeRemoval', scenario.preview);
            else previewAssertion.not.toHaveProperty('request.preview.deploymentReview.removal.volumeRemoval');
            expect(writes).toEqual([]);

            shared = scenario.after;
            const settled = await settle(pending);
            if (loseVolumeAcknowledgement) {
                expect(settled).toMatchObject({ ok: false, errorCode: 'outcome_unknown',
                    failureCause: { phase: 'deployment.railway.data.volume_delete' } });
                expect(writes).toEqual([{ kind: 'service', id: serviceId, environmentId }, { kind: 'volume', id: volumeId }]);
                const history = DeploymentReceiptListResultV1Schema.parse(await resultOf('deployments.receipts.list', address));
                if (!history.ok) throw new Error(history.error);
                const receipt = history.items.find(row => row.operation === 'teardown' && row.requestKey === removal.requestKey);
                if (!receipt || receipt.state !== 'outcome_unknown') throw new Error('Expected the unsettled teardown receipt');
                const artifact = await artifacts.read(receipt.contentArtifactId);
                if (typeof artifact?.body !== 'string') throw new Error('The encrypted removal receipt must be readable by its owner');
                const stored = DeploymentProviderTeardownContentV1Schema.parse(JSON.parse(artifact.body));
                expect(stored.platform.observation.volumeRemoval).toEqual({ kind: 'kept-unchecked' });
                continue;
            }
            if (!settled.ok) throw new Error(`Railway teardown approval refused: ${JSON.stringify({ errorCode: settled.errorCode, error: settled.error, failureCause: settled.failureCause })}`);
            const receipt = DeploymentReceiptResultV1Schema.parse(settled.result);
            expect(receipt).toMatchObject({ ok: true, state: 'succeeded' });
            if (!receipt.ok || !('deploymentId' in receipt)) throw new Error('Railway removal requires a retained receipt');
            const header = DeploymentReceiptGetResultV1Schema.parse(await resultOf('deployments.receipts.get', { ...address, deploymentId: receipt.deploymentId }));
            if (!header.ok) throw new Error(`Railway teardown receipt refused: ${header.error}`);
            const artifact = await artifacts.read(header.deployment.contentArtifactId);
            if (typeof artifact?.body !== 'string') throw new Error('The encrypted removal receipt must be readable by its owner');
            const stored = DeploymentProviderTeardownContentV1Schema.parse(JSON.parse(artifact.body));
            expect(stored.platform.observation).toMatchObject({ state: 'succeeded' });
            const observationAssertion = expect.soft(stored.platform.observation, scenario.name);
            if ('observation' in scenario) observationAssertion.toHaveProperty('volumeRemoval', scenario.observation);
            else observationAssertion.not.toHaveProperty('volumeRemoval');
            expect.soft(writes, scenario.name).toEqual([{ kind: 'service', id: serviceId, environmentId },
                ...('observation' in scenario && scenario.observation.kind === 'removed' ? [{ kind: 'volume', id: volumeId }] : [])]);
        }
    } finally { providerHttp.mockReset(); }
}
