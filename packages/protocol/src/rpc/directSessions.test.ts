import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './index.js';

describe('RPC_METHODS (daemon direct sessions)', () => {
  it('does not expose unsuffixed daemon.directSessions.* constants as canonical API', () => {
    const rpcMethods = RPC_METHODS as Record<string, string>;

    expect(rpcMethods.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST).toBeUndefined();
    expect(rpcMethods.DAEMON_DIRECT_SESSION_LINK_ENSURE).toBeUndefined();
    expect(rpcMethods.DAEMON_DIRECT_SESSION_ATTACH).toBeUndefined();
    expect(rpcMethods.DAEMON_DIRECT_SESSION_DETACH).toBeUndefined();
    expect(rpcMethods.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET).toBeUndefined();
    expect(rpcMethods.DAEMON_DIRECT_SESSION_STATUS_GET).toBeUndefined();
    expect(rpcMethods.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE).toBeUndefined();
    expect(rpcMethods.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER).toBeUndefined();
    expect(rpcMethods.DAEMON_DIRECT_SESSION_TAKEOVER).toBeUndefined();
    expect(rpcMethods.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST).toBeUndefined();
  });

  it('includes canonical daemon.externalSessions.* methods', () => {
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST).toBe(
      'daemon.externalSessions.candidates.list',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSION_LINK_ENSURE).toBe(
      'daemon.externalSessions.link.ensure',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSION_ATTACH).toBe(
      'daemon.externalSessions.attach',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSION_DETACH).toBe(
      'daemon.externalSessions.detach',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET).toBe(
      'daemon.externalSessions.backgroundFollow.set',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSION_STATUS_GET).toBe(
      'daemon.externalSessions.status.get',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE).toBe(
      'daemon.externalSessions.transcript.page',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER).toBe(
      'daemon.externalSessions.transcript.readAfter',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSION_TAKEOVER).toBe(
      'daemon.externalSessions.takeover',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSION_MATERIALIZE_START).toBe(
      'daemon.externalSessions.materialize.start',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSION_TAKEOVER_START).toBe(
      'daemon.externalSessions.takeover.start',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET).toBe(
      'daemon.externalSessions.operation.status.get',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSION_OPERATION_CANCEL).toBe(
      'daemon.externalSessions.operation.cancel',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSION_OPERATION_RESUME).toBe(
      'daemon.externalSessions.operation.resume',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSION_OPERATION_RETRY).toBe(
      'daemon.externalSessions.operation.retry',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_EXTERNAL_SESSION_OPERATION_DISCARD).toBe(
      'daemon.externalSessions.operation.discard',
    );
  });

  it('includes legacy daemon.directSessions.* methods', () => {
    expect((RPC_METHODS as Record<string, string>).DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY).toBe(
      'daemon.directSessions.candidates.list',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_DIRECT_SESSION_LINK_ENSURE_LEGACY).toBe(
      'daemon.directSessions.link.ensure',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_DIRECT_SESSION_ATTACH_LEGACY).toBe(
      'daemon.directSessions.attach',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_DIRECT_SESSION_DETACH_LEGACY).toBe(
      'daemon.directSessions.detach',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET_LEGACY).toBe(
      'daemon.directSessions.followPolicy.set',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_DIRECT_SESSION_STATUS_GET_LEGACY).toBe(
      'daemon.directSessions.status.get',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE_LEGACY).toBe(
      'daemon.directSessions.transcript.page',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER_LEGACY).toBe(
      'daemon.directSessions.transcript.readAfter',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY).toBe(
      'daemon.directSessions.takeover',
    );
    expect((RPC_METHODS as Record<string, string>).DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY).toBe(
      'daemon.directSessions.takeoverPersist',
    );
  });
});
