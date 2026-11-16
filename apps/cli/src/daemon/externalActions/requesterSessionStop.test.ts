import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createRequesterSessionStopEffect } from './requesterSessionStop';

describe('createRequesterSessionStopEffect', () => {
  it.each([
    ['session.stop', 'session.stop'],
    ['session.archive', 'session.stop'],
    ['session.delete', 'session.stop'],
    ['session.sections.archive', 'session.stop'],
  ] as const)(
    'signs the received native Stop of a %s root as its admitted %s phase',
    async (rootActionId, effect) => {
      // MACH-PRINCIPAL-AUDIT-1116: Home admits the hosted Stop as the session.stop
      // phase, so its reads and owner-tuple retirement must carry that effect.
      const keys = tweetnacl.sign.keyPair();
      const target = { kind: 'session' as const, sessionId: 'hosted-session' };
      // Boundary fixture: only the binding fields the local header signer reads.
      const authorization = {
        token: 'signed-root',
        binding: {
          actionId: rootActionId,
          requestId: 'request-1',
          serverIdentityId: 'home-1',
          accountId: 'member',
          machineId: 'machine-1',
          installationId: 'installation-1',
          target,
        },
      } as unknown as ExternalActionExecutionAuthorizationV1;
      const requester = {
        authorization,
        credentials: { token: 'member-token', encryption: null },
        serverHttpBaseUrl: 'https://home.test',
        isCurrent: async () => true,
      } as unknown as RequesterAccountActionContext;
      const signedEffects: unknown[] = [];
      const stop = createRequesterSessionStopEffect({
        requester,
        purpose: {
          kind: 'machine_rpc',
          method: RPC_METHODS.STOP_SESSION,
          params: { sessionId: target.sessionId },
        },
        machineId: 'machine-1',
        installation: {
          installationId: 'installation-1',
          privateKey: keys.secretKey,
        },
        // The physical process Stop is the boundary; it observes the headers its retirement PATCH would carry.
        stopSession: async (sessionId, options) => {
          const headers =
            options.metadataContext?.resolveAuthorizationHeaders?.({
              method: 'PATCH',
              path: `/v2/sessions/${sessionId}`,
              body: { mode: 'owner' },
            });
          signedEffects.push(headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]);
          return { status: 'stopped' } as never;
        },
      });
      await stop({
        sessionId: target.sessionId,
        stopIntent: 'explicit' as never,
        context: {
          surface: 'cli',
          authority: 'present_user',
          externalActionExecutionAuthorization: authorization,
          externalActionTarget: target,
        } as never,
      });
      expect(signedEffects).toEqual([effect]);
    },
  );
});
