import fastify from 'fastify';
import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { reloadConfiguration } from '@/configuration';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { withTempDir } from '@/testkit/fs/tempDir';

import { createAccountServerActionDeps } from './accountServerActionDeps';

const homeId = 'srv_replay_home';
const otherHome = 'srv_other_home';
const receiverProfile = 'receiver-profile';
const creatorProfile = 'creator-profile';
const machineId = 'receiver-machine';
const endpoint = 'https://approval-replay.test';

const probes = {
  home: { actionId: 'account.profile.get', input: {}, path: '/v1/account/profile' },
  sessionAccess: { actionId: 'session.access.candidates.inspect', input: { v: 1, sessionId: 'shared', subjects: [] }, path: '/v2/sessions/access-candidates/inspect' },
  machineAccess: { actionId: 'machines.access.grants.list', input: { serverId: homeId, machineId: 'shared' }, path: '/v1/machines/shared/access' },
  projectWorker: { actionId: 'projects.worker.preferences.get', input: { workspace: { serverId: homeId, refId: 'checkout' } }, path: '/v1/projects/execution/config/read' },
  machinePool: { actionId: 'machines.pools.list', input: {}, path: '/v1/machines/pools/list' },
  machinePreset: { actionId: 'machines.presets.list', input: { homeId }, path: '/v1/machines/presets/list' },
  managedMachine: { actionId: 'machines.managed.list', input: { homeId }, path: '/v1/machines/managed/actions/list' },
  accountSecurity: { actionId: 'account.security.get', input: {}, path: '/v1/account/security' },
  accountTokens: { actionId: 'account.apiTokens.list', input: {}, path: '/v1/auth/api-tokens/list' },
  accountSessions: { actionId: 'account.sessions.signOutEverywhere', surface: 'ui', input: {}, path: '/v1/auth/sessions/sign-out-everywhere' },
  usage: { actionId: 'usage.prices.get', input: {}, path: '/v1/account/usage/prices' },
} as const;

async function replay(probe: Readonly<{ actionId: string; input: unknown; path: string; surface?: 'ui' }>, options: Readonly<{
  originHome?: string;
  originProfile: string;
  transportHome?: string;
  forge?: boolean;
}>) {
  return await withTempDir('account-approval-replay-home-', async home => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    env.patch({ HAPPIER_HOME_DIR: home });
    reloadConfiguration();
    const app = fastify();
    const requests: string[] = [];
    app.addHook('onRequest', async request => { requests.push(request.url.split('?')[0]!); });
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 0 }));
    app.setNotFoundHandler(async (_, reply) => reply.code(501).send());
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    try {
      const credentials = { token: 'fixture-token', encryption: null };
      const surface = probe.surface ?? 'cli';
      let request = ApprovalRequestV2Schema.parse({
        v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
        createdBy: { surface: 'system' }, requestedSurface: surface, actionId: probe.actionId,
        approval: { flow: 'deferred', result: 'required' },
        actionArgs: probe.input, summary: 'Review this Action',
        decision: { kind: 'approve', authority: 'present_user', decidedAtMs: 2 },
        executionOriginV1: {
          v: 1, authority: 'present_user', surface, caller: { kind: 'host' },
          serverId: options.originProfile, serverIdentityId: options.originHome, accountId: 'owner',
          machineId, actionId: probe.actionId, requestId: 'fixture-ask',
        },
      });
      const executor = createActionExecutor({
        ...createUnavailableActionTransportDeps(),
        ...createAccountServerActionDeps({
          token: credentials.token, credentials, serverId: receiverProfile,
          serverIdentityId: options.transportHome ?? homeId, serverHttpBaseUrl: endpoint,
        }),
        approvalsGet: async () => structuredClone(request),
        approvalsUpdate: async ({ request: next, expectedStatus }) => {
          const transition = decideApprovalRequestTransition(request, next, { expectedStatus });
          if (transition.ok) request = ApprovalRequestV2Schema.parse(next);
          return transition;
        },
        isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({
          accountId: 'owner', machineId, serverId: receiverProfile,
          resolveCurrentMachineExecutionOriginContext: async () => ({ machineId, serverIdentityId: homeId }),
          resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
          isAccountCurrent: async () => true, listAccountApiTokens: async () => ({ tokens: [] }),
        }),
      });
      const forged = options.forge ? { verifiedDaemonReplayHome: homeId } : {};
      const result = await executor.replayApprovedApprovalRequest({
        artifactId: 'fixture-approval', callerAuthority: 'present_user', ...forged,
      }, { signal: new AbortController().signal, ...forged });
      return { result, request, requests };
    } finally {
      restore();
      await app.close();
      env.restore();
      reloadConfiguration();
    }
  });
}

it.each(Object.entries(probes))('replays the %s adapter only at the approved Home', async (_, probe) => {
  const different = await replay(probe, { originProfile: receiverProfile, originHome: otherHome });
  expect(different.result).toMatchObject({ ok: false, errorCode: 'approval_stale', details: { reason: 'home_changed' }, effectAttempted: false });
  expect(different.requests).toEqual([]);

  const same = await replay(probe, { originProfile: creatorProfile, originHome: homeId });
  expect(same.requests, JSON.stringify(same.result)).toContain(probe.path);
});

it.each([
  { ...probes.machineAccess, input: { ...probes.machineAccess.input, serverId: otherHome } },
  { ...probes.projectWorker, input: { workspace: { serverId: otherHome, refId: 'checkout' } } },
  { ...probes.machinePreset, input: { homeId: otherHome } },
  { ...probes.managedMachine, input: { homeId: otherHome } },
])('refuses the explicit foreign Home operand of $actionId even after exact-daemon currentness', async probe => {
  const { request, requests } = await replay(probe, { originProfile: creatorProfile, originHome: homeId });
  expect(request).toMatchObject({ status: 'failed', execution: { errorCode: 'server_target_mismatch' } });
  expect(requests).toEqual([]);
});

it('keeps a legacy origin on the saved-profile operand check', async () => {
  const accepted = await replay({
    ...probes.projectWorker,
    input: { workspace: { serverId: receiverProfile, refId: 'checkout' } },
  }, { originProfile: receiverProfile });
  expect(accepted.requests, JSON.stringify(accepted.result)).toContain(probes.projectWorker.path);

  const refused = await replay(probes.projectWorker, { originProfile: receiverProfile });
  expect(refused.request).toMatchObject({ status: 'failed', execution: { errorCode: 'server_target_mismatch' } });
  expect(refused.requests).toEqual([]);
});

it('ignores a caller-supplied replay Home in args and Machine ingress', async () => {
  const { request, requests } = await replay(probes.projectWorker, { originProfile: receiverProfile, forge: true });
  expect(request).toMatchObject({ status: 'failed', execution: { errorCode: 'server_target_mismatch' } });
  expect(requests).toEqual([]);
});

it('refuses an Account transport bound to a different Home than the receiving daemon', async () => {
  const { request, requests } = await replay(probes.home, {
    originProfile: receiverProfile, originHome: homeId, transportHome: otherHome,
  });
  expect(request).toMatchObject({ status: 'failed', execution: { errorCode: 'server_target_mismatch' } });
  expect(requests).toEqual([]);
});
