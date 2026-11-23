import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Real: the Fork Action entry, Session transport parsing, owner-metadata opening and the
// publisher routing owner. Replaced: Home HTTP. The shared Session record carries exactly
// what Home sends a recipient: no owner locality, plus the routing hint when the recipient
// holds a grant on the Session's Machine (server C79). A distinctive Home refusal proves the
// Fork reached Home's Machine admission, which still decides whether the child may run.
it.each([
  { caller: 'owner', grant: 'manage' },
  { caller: 'guest', grant: 'use' },
  { caller: 'guest', grant: null },
] as const)(
  'routes a $caller Fork with Machine grant $grant',
  async ({ caller, grant }) => {
    await withConfiguredDaemonTestHome({ prefix: 'guest-fork-' }, async () => {
      const token = `header.${Buffer.from(
        JSON.stringify({
          sub: caller,
          tokenEpoch: 4,
          provenance: { v: 1, kind: 'account', authority: 'present_user' },
        }),
      ).toString('base64url')}.signature`;
      const sessionId = 'cmwt2olu5025agbmcwgbp5g3a';
      const session = createSessionRecordFixture({
        id: sessionId,
        active: true,
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ...(caller === 'owner'
          ? {
              machineId: 'parent-machine',
              share: null,
              ownerMetadata: { t: 'plain', v: { v: 1 } },
            }
          : {
              share: { accessLevel: 'edit', canApprovePermissions: false },
              ...(grant
                ? {
                    computerMachineBinding: {
                      homeId: 'srv_home',
                      machineId: 'parent-machine',
                    },
                  }
                : {}),
            }),
      });
      const machine = {
        id: 'parent-machine',
        active: true,
        revokedAt: null,
        replacedByMachineId: null,
        kind: 'persistent',
        // The installed receiver a guest's sign-in is sealed to (2026-11-23: never refused).
        installationId: 'parent-installation',
        installationPublicKey: Buffer.alloc(32, 7).toString('base64'),
        access: {
          custodian: { accountId: 'owner', displayName: 'Owner' },
          role: grant,
          resourceMode: 'plain',
          accessState: 'ready',
        },
      };
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
          return { status: 200, data: grant ? [machine] : [] };
        if (url.endsWith('/v1/machines/parent-machine'))
          return grant
            ? {
                status: 200,
                data: { machine: { ...machine, encryptionMode: 'plain' } },
              }
            : { status: 404, data: { error: 'not_found' } };
        throw new Error(`Unexpected Home read ${url}`);
      });
      const admission = vi
        .spyOn(axios, 'post')
        .mockImplementation(async (_url, body) => {
          const request = body as { requestId: string };
          return {
            status: 200,
            data: {
              v: 1,
              actionId: 'session.fork',
              requestId: request.requestId,
              execution: {
                ok: false,
                errorCode: 'admission_unavailable',
                error: 'admission_unavailable',
              },
            },
          };
        });
      vi.stubGlobal('fetch', async () =>
        Response.json({ ok: false, errorCode: 'target_not_local' }),
      );
      const executor = createCliActionExecutorFromCredentials({
        credentials: {
          token,
          encryption: null,
          credentialProvenance: 'stored_session',
        },
        externalActionClient: true,
        serverId: configuration.activeServerId,
        serverIdentityId: 'srv_home',
        serverApiUrl: 'https://home.test',
        actionsSettingsProvider: {
          getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }),
        },
      });
      const result = await executor.execute(
        'session.fork',
        { sessionId, strategy: 'replay' },
        { surface: 'cli' },
      );
      if (caller === 'owner') {
        expect(result, JSON.stringify(result)).toMatchObject({
          ok: false,
          errorCode: 'admission_unavailable',
        });
        expect(admission, JSON.stringify(result)).toHaveBeenCalled();
      } else if (grant) {
        // The guest's sealed Fork reaches Home's execution authorization, where Machine
        // admission decides (this fixture's Home answers no authorization).
        expect(result, JSON.stringify(result)).not.toMatchObject({ errorCode: 'target_unavailable' });
        expect(admission.mock.calls.map(([url]) => String(url))).toContainEqual(
          expect.stringContaining('/v1/actions/session.fork/execution-authorization'));
      } else {
        // No grant on the Session's Machine: nothing is sent and the routing refusal stands.
        expect(result, JSON.stringify(result)).toMatchObject({
          ok: false,
          errorCode: 'target_unavailable',
        });
        expect(admission).not.toHaveBeenCalled();
      }
    });
  },
);
