import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema, decodePlainArtifactStoredContent, normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { MachineAdminAccessMutationResultV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { registerAccountHomeHttp, registerPlainArtifactRoutes } from './widgetApproval.testkit';

afterEach(() => { vi.restoreAllMocks(); });

it.each((['captured', 'resolved'] as const).flatMap(identity =>
    (['canonical', 'creator-profile', 'foreign-home'] as const).map(operand => ({ identity, operand })),
))('keeps CLI admin Ask on its verified Home with $identity identity and $operand operand', async ({ identity, operand }) =>
    withConfiguredDaemonTestHome({ prefix: 'happier-admin-home-replay-' }, async () => {
    const app = fastify();
    const endpoint = 'https://machine-home-approval.test';
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    const creatorProfile = 'creator-local-profile';
    const homeId = 'srv_machine_home_approval';
    const daemonHomeId = operand === 'foreign-home' ? 'srv_another_home' : homeId;
    let daemonProfile = 'daemon-local-profile';
    if (identity === 'resolved') {
        const profile = await addServerProfile({ name: daemonProfile, serverUrl: endpoint, webappUrl: endpoint });
        daemonProfile = profile.id;
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
            v: 1, homeServerIdentityId: daemonHomeId, canonicalServerUrl: endpoint, revision: 1,
            endpoints: [{ kind: 'https', url: endpoint }],
        } });
    }
    const machineId = 'admin-machine';
    const accountId = 'admin-owner';
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const };
    const features = registerAccountHomeHttp(app, { accountId, serverId: daemonHomeId });
    const artifacts = registerPlainArtifactRoutes(app, accountId);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
    // Home HTTP/Artifact persistence and the final Machine RPC are boundaries.
    // Proposal construction, decision, origin verification and replay are real.
    const effects: unknown[] = [];
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
        expect(request.machineId).toBe(machineId);
        effects.push(request.request);
        return MachineAdminAccessMutationResultV1Schema.parse({ status: 'applied',
            policy: { version: 1, mode: 'ask', administratorUsername: 'happier-bootstrap' }, metadataVersion: 2,
            effect: { outcome: 'applied', observation: { version: 1, observedAt: 20, daemonUid: 1001,
                daemonUsername: 'happier', daemonIdentity: 'nonRoot', rootEquivalentGroups: [],
                passwordlessSudoToRoot: 'denied', managedDropIn: 'valid', tailscaledOperator: { authorization: 'denied' } } } });
    });
    const policy = { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {
        'machines.setup.adminAccess.set': { approvalRequiredSurfaces: ['cli'] },
    } }), getAccountSettings: () => ({}) };
    const common = { token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain' as const,
        ctx: null, serverIdentityId: homeId, serverHttpBaseUrl: endpoint, actionsSettingsProvider: policy };
    const { executor: creator } = createCliActionExecutorHarness({ ...common, serverId: creatorProfile });
    const { executor: daemon } = createCliActionExecutorHarness({ ...common, serverId: daemonProfile,
        serverIdentityId: identity === 'captured' ? daemonHomeId : undefined,
        machineActionDirectTargetTransport: { machineId, invoke: async () => { throw new Error('Admin effects require authenticated Machine RPC'); } },
    }, { isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
        machineId, serverId: daemonProfile, serverApiUrl: endpoint }) });
    const input = { serverId: operand === 'creator-profile' ? creatorProfile : homeId, machineId, expectedMetadataVersion: 1,
        expectedAdminAccess: { version: 1, mode: 'preauthorized' },
        adminAccess: { version: 1, mode: 'ask', administratorUsername: 'happier-bootstrap' }, comparison: 'field' };
    try {
        const proposed = await runWithServerHttpBaseUrl(endpoint, () => creator.execute('machines.setup.adminAccess.set', input,
            { surface: 'cli', authority: 'present_user', serverId: creatorProfile, serverIdentityId: homeId,
                runtimeAccountId: accountId, defaultSessionMachineId: machineId, actionRequestId: 'admin-ask' }));
        expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, result: { artifactId: expect.any(String) } });
        if (!proposed.ok || typeof proposed.result !== 'object' || !proposed.result || !('artifactId' in proposed.result)
            || typeof proposed.result.artifactId !== 'string') throw new Error('Missing approval Artifact');
        const artifactId = proposed.result.artifactId;
        expect(effects).toEqual([]);
        const result = await runWithServerHttpBaseUrl(endpoint, () => daemon.execute('approval.request.decide',
            { artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user', serverId: daemonProfile,
                serverIdentityId: daemonHomeId, runtimeAccountId: accountId }));
        if (operand === 'foreign-home') {
            expect(result).toMatchObject({ ok: false, errorCode: 'approval_stale', details: { reason: 'home_changed' } });
            expect(effects).toEqual([]);
            return;
        }
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
        expect(effects).toEqual([input]);
        const stored = decodePlainArtifactStoredContent(artifacts.read(artifactId)!.body);
        if (!stored || typeof stored !== 'object' || !('body' in stored) || typeof stored.body !== 'string') throw new Error('Missing approval body');
        expect(ApprovalRequestV2Schema.parse(JSON.parse(stored.body))).toMatchObject({ status: 'executed',
            actionArgs: input, executionOriginV1: { serverId: creatorProfile, serverIdentityId: homeId, machineId } });
    } finally { restore(); await app.close(); }
}));
