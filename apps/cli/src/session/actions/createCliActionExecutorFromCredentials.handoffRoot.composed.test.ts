import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createDefaultWorkspaceContentPolicyV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

// BL218 item 1(b): a Can use guest's original CLI Handoff must reach its source
// Machine with a Home-minted `session.handoff` root, as the app does, so the
// source coordinator signs prepareTarget as a continuation Home admits at Use.
describe('original CLI session.handoff root', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it.each(['none', 'copy_once', 'create_relationship'] as const)(
    'delivers a guest Handoff (%s) through Home Action admission, never a raw source RPC',
    async (kind) => {
      await withConfiguredDaemonTestHome(
        { prefix: 'happier-cli-handoff-root-' },
        async () => {
          const token = `header.${Buffer.from(
            JSON.stringify({
              sub: 'guest',
              tokenEpoch: 4,
              provenance: { v: 1, kind: 'account', authority: 'present_user' },
            }),
          ).toString('base64url')}.signature`;
          const credentials = {
            token,
            encryption: null,
            credentialProvenance: 'stored_session' as const,
          };
          const sessionId = 'cmwj23tjg023wmczdkdcf0vsi';
          // The guest's own Session runs on the owner's Machine, shared to the guest at Use.
          const session = createSessionRecordFixture({
            id: sessionId,
            active: true,
            encryptionMode: 'plain',
            share: null,
            metadata: JSON.stringify({
              machineId: 'owner-source',
              path: '/home/guest/project',
              flavor: 'claude',
            }),
          });
          // The owner's Machine as Home lists it to a Can use guest.
          const sourceMachine = {
            id: 'owner-source',
            active: true,
            revokedAt: null,
            replacedByMachineId: null,
            kind: 'persistent',
            installationId: 'owner-source-installation',
            installationPublicKey: Buffer.alloc(32, 7).toString('base64'),
            access: {
              custodian: { accountId: 'owner', displayName: 'Owner' },
              role: 'use',
              resourceMode: 'plain',
              accessState: 'ready',
            },
          };
          vi.stubGlobal('fetch', async () =>
            Response.json({ ok: false, errorCode: 'target_not_local' }),
          );
          vi.spyOn(axios, 'get').mockImplementation(async (url) => {
            if (url.endsWith(`/v2/sessions/${sessionId}`))
              return { status: 200, data: { session } };
            if (url.endsWith('/v1/account/encryption/currentness'))
              return {
                status: 200,
                data: {
                  mode: 'plain',
                  version: 1,
                  signingKeyFingerprint: null,
                  contentKeyFingerprint: null,
                  updatedAt: 1,
                },
              };
            if (url.endsWith('/v1/account/encryption'))
              return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (url.endsWith('/v1/machines'))
              return { status: 200, data: [sourceMachine] };
            if (url.endsWith('/v1/machines/owner-source'))
              return {
                status: 200,
                data: { machine: { ...sourceMachine, encryptionMode: 'plain' } },
              };
            throw new Error(`Unexpected Home read: ${url}`);
          });
          const posts: Array<{ url: string; body: unknown }> = [];
          vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            posts.push({ url, body });
            // Home refuses after recording the admission request; the route is the observed fact.
            return {
              status: 409,
              data: { error: 'invalid_request', code: 'target_unavailable' },
            };
          });
          const executor = createCliActionExecutorFromCredentials({
            credentials,
            externalActionClient: true,
            serverId: configuration.activeServerId,
            serverIdentityId: 'srv_home',
            serverApiUrl: 'https://home.test',
            actionsSettingsProvider: {
              getActionsSettings: () =>
                ActionsSettingsV1Schema.parse({
                  v: 1,
                  approvalWaivedSurfaces: { 'session.handoff': ['cli'] },
                }),
            },
          });
          const contentPolicy = createDefaultWorkspaceContentPolicyV1();
          const workspaceAction =
            kind === 'none'
              ? { kind }
              : kind === 'copy_once'
                ? { kind, contentPolicy }
                : {
                    kind,
                    mode: 'keep_synced',
                    contentPolicy,
                    flushBeforeCommit: true,
                  };
          const result = await executor.execute(
            'session.handoff',
            {
              sessionId,
              targetMachineId: 'owner-target',
              targetPath: '/home/guest/project',
              workspaceAction,
            },
            { surface: 'cli' },
          );
          // Home mints the guest's session.handoff root (requester execution
          // authorization) before delivering the whole Action to the source Machine.
          const admissions = posts.filter((post) =>
            post.url.startsWith('https://home.test/v1/actions/session.handoff'),
          );
          expect(
            posts.map((post) => post.url),
            JSON.stringify(posts.map((post) => post.url)),
          ).not.toContain(expect.stringContaining('/v1/machines/'));
          expect(
            admissions,
            JSON.stringify({ posts: posts.map((post) => post.url), result }),
          ).toHaveLength(1);
          expect(JSON.stringify(admissions[0]!.body)).toContain('owner-source');
        },
      );
    },
  );
});
