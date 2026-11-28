import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import { io } from 'socket.io-client';
import tweetnacl from 'tweetnacl';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetServerFeaturesClientForTests();
});

// BL218 item 1(a): REPLACEMENT_PREFLIGHT is a Manage route at Home. A Can use
// requester on another person's TARGET copies inside their own member capture,
// which the TARGET decides in-flow, so the up-front Account read is not sent.
// The custodian and Manage requesters keep today's destination preflight.
it.each([
  {
    requester: 'use guest',
    role: 'use',
    custodian: 'owner',
    sendsPreflight: false,
  },
  {
    requester: 'manage guest',
    role: 'manage',
    custodian: 'owner',
    sendsPreflight: true,
  },
  {
    requester: 'target custodian',
    role: 'use',
    custodian: 'requester',
    sendsPreflight: true,
  },
  {
    requester: 'unlisted access',
    role: null,
    custodian: null,
    sendsPreflight: true,
    rowReadFails: false,
  },
  {
    requester: 'row read 500 fallback',
    role: 'manage',
    custodian: 'owner',
    sendsPreflight: true,
    rowReadFails: true,
  },
] as const)(
  'decides the Handoff destination preflight for a $requester',
  async ({ role, custodian, sendsPreflight, ...rest }) => {
    const rowReadFails = 'rowReadFails' in rest ? rest.rowReadFails : false;
    for (const kind of ['copy_once', 'create_relationship'] as const) {
      const home = 'srv_handoff_home';
      const serverHttpBaseUrl = 'https://handoff.example.test';
      const sessionId = 'cmwagqalz008omccdtt4qggcq';
      const machineId = 'source';
      const targetMachineId = 'destination';
      const installationId = 'source-installation';
      const target = { kind: 'machine' as const, machineId };
      const credentials = { token: 'requester-fixture', encryption: null };
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
        v: 1,
        token: 'handoff-admission',
        binding: {
          actionId: 'session.handoff',
          accountId: 'requester',
          custodianAccountId: 'owner',
          authentication: { kind: 'account', tokenEpoch: 0 },
          accountEncryptionMode: 'plain',
          serverIdentityId: home,
          machineId,
          installationId,
          target,
          requestId: 'handoff-request',
          requestEnvelopeDigest: 'a'.repeat(43),
          handoffAdmission: {
            sessionId,
            sourceMachineId: machineId,
            sourceInstallationId: installationId,
            targetMachineId,
            targetInstallationId: 'destination-installation',
          },
        },
      });
      const currentness = {
        mode: 'plain',
        version: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: null,
        updatedAt: 1,
        recipientEnvelopeReadiness: {
          status: 'unavailable',
          reason: 'plain_account',
        },
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            features: {},
            capabilities: {
              encryption: {
                storagePolicy: 'optional',
                allowAccountOptOut: true,
                defaultAccountMode: 'plain',
              },
            },
          }),
        ),
      );
      let machineRowReads = 0;
      vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        const path = new URL(String(url)).pathname;
        expect(config?.headers?.Authorization).toBe('Bearer requester-fixture');
        if (path === '/v1/account/encryption/currentness')
          return { status: 200, data: currentness };
        // Home's access projection of the TARGET to this requester (the one read Home answers).
        if (path === `/v1/machines/${targetMachineId}`) {
          if (rowReadFails && machineRowReads++ === 0) throw Object.assign(new Error('500'), { response: { status: 500 } });
          return {
            status: 200,
            data: {
              machine: {
                id: targetMachineId,
                storageMode: 'plain',
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                managedMachineRef: null,
                metadata: null,
                metadataVersion: 0,
                daemonState: null,
                daemonStateVersion: 0,
                ...(role && custodian
                  ? {
                      access: {
                        custodian: {
                          accountId: custodian,
                          displayName: custodian,
                        },
                        role,
                        resourceMode: 'plain',
                        accessState: 'ready',
                      },
                    }
                  : {}),
              },
            },
          };
        }
        throw new Error(`Unexpected Home read ${path}`);
      });
      const sent: string[] = [];
      vi.mocked(io).mockImplementation(
        () =>
          createApiSessionSocketStub({
            emitWithAck: (event, packet) => {
              expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
              sent.push(String((packet as { method?: unknown }).method));
              return { ok: true, result: { type: 'not_required' } };
            },
          }) as unknown as ReturnType<typeof io>,
      );
      const admitted = await projectRequesterAccountActionAuthorization({
        authorization,
        serverIdentityId: home,
        bootstrap: {
          attribution: {
            serverId: home,
            accountId: 'requester',
            machineId,
            installationId,
          },
          credentials,
          serverHttpBaseUrl,
          isCurrent: async () => true,
        },
      });
      if (!admitted)
        throw new Error('The test requester must have admitted custody');
      const deps = createCliActionDeps({
        token: credentials.token,
        credentials,
        sessionId,
        mode: 'plain',
        ctx: null,
        serverId: home,
        serverIdentityId: home,
        serverHttpBaseUrl,
        externalActionMachineInstallationId: installationId,
        externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(
          new Uint8Array(32),
        ).secretKey,
        actionsSettingsProvider: createActionSettingsProvider({
          accountSettings: accountSettingsParse({}),
        }),
      });
      const policy = {
        v: 1 as const,
        selection: 'git_worktree' as const,
        extraIgnorePatterns: [],
        extraIncludePatterns: [],
      };
      const contentPolicy = {
        ...policy,
        policyDigest: computeWorkspaceSyncPolicyDigest(policy),
      };
      const workspaceAction =
        kind === 'copy_once'
          ? { kind, contentPolicy }
          : {
              kind,
              mode: 'keep_synced' as const,
              contentPolicy,
              flushBeforeCommit: true as const,
            };
      const result =
        await deps.sessionHandoffTargetReplacementApprovalPreflight!({
          sessionId,
          targetMachineId,
          targetPath: '/home/requester/project',
          workspaceAction,
          serverId: home,
          operationId: 'handoff-request',
          effectActionId: 'session.handoff',
          context: {
            surface: 'cli' as const,
            authority: 'present_user' as const,
            externalActionExecutionAuthorization: admitted,
            externalActionTarget: target,
          },
        });
      expect(result, `${kind}: ${JSON.stringify(result)}`).toEqual({
        type: 'not_required',
      });
      expect(sent, kind).toEqual(
        sendsPreflight
          ? [
              `${targetMachineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`,
            ]
          : [],
      );
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      resetServerFeaturesClientForTests();
    }
  },
);
