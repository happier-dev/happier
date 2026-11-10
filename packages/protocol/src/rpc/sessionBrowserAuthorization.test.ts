import { describe, expect, it } from 'vitest';
import * as socket from './socket.js';
import { projectSessionAccessCapabilitiesV1 } from '../sessions/access/sessionEffectiveAccessV1.js';
import { MachineLiveStreamRelayAuthorizationPayloadV1Schema } from '../machines/peer/mediation/stream/v1.js';

describe('Session Browser transport authorization', () => {
  it.each(['view', 'edit'] as const)('retains the canonical %s decision and exact installed source', (level) => {
    const authorization = { kind: 'session.browser', sessionId: 'session', actorAccountId: 'recipient',
      custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation',
      effectiveAccess: { v: 1, level, sources: [{ kind: 'direct', shareId: 'share' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: false, grants: [{ accessLevel: level, canApprovePermissions: false }] }) } };
    expect(socket.parseSocketRpcAuthorizationContext(authorization)).toEqual(authorization);
    expect(socket.parseSocketRpcAuthorizationContext({ ...authorization, effectiveAccess: null })).toBeNull();
    expect(socket.parseSocketRpcAuthorizationContext({ ...authorization, machineId: '' })).toBeNull();
    expect(socket.parseSocketRpcAuthorizationContext({ ...authorization, extra: true })).toBeNull();
    const relay = { v: 2, grantId: 'grant', accountId: 'owner', sourceMachineId: 'machine', targetMachineId: 'machine',
      flowKind: 'live_stream', routeKind: 'server_relay', streamId: 'stream', streamFamily: 'browser.streamed',
      sourceId: 'source', viewerSocketId: 'socket', viewerAccountId: 'recipient', sourceMachineInstallationId: 'installation',
      iat: 1, exp: 2, aud: 'happier-live-stream-relay-authorization', sessionBrowserAccess: authorization,
      personalSourceAdmission: { homeServerIdentityId: 'home', actorAccountId: 'recipient', streamFamily: 'browser.streamed',
        sourceId: 'source', sourceOccurrenceId: 'occurrence', sessionBrowserSessionId: 'session' } };
    expect(MachineLiveStreamRelayAuthorizationPayloadV1Schema.safeParse(relay).success).toBe(true);
    expect(MachineLiveStreamRelayAuthorizationPayloadV1Schema.safeParse({ ...relay, sessionBrowserAccess: undefined }).success).toBe(false);
    expect(MachineLiveStreamRelayAuthorizationPayloadV1Schema.safeParse({ ...relay, accountId: 'another-custodian' }).success).toBe(false);
    expect(MachineLiveStreamRelayAuthorizationPayloadV1Schema.safeParse({ ...relay, streamFamily: 'computer',
      personalSourceAdmission: { ...relay.personalSourceAdmission, streamFamily: 'computer' } }).success).toBe(false);
  });
});
