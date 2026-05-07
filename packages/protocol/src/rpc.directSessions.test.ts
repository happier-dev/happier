import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './rpc.js';

describe('RPC_METHODS (daemon direct sessions)', () => {
  it('includes daemon.directSessions.* methods', () => {
    expect((RPC_METHODS as any).DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST).toBe('daemon.directSessions.candidates.list');
    expect((RPC_METHODS as any).DAEMON_DIRECT_SESSION_LINK_ENSURE).toBe('daemon.directSessions.link.ensure');
    expect((RPC_METHODS as any).DAEMON_DIRECT_SESSION_ATTACH).toBe('daemon.directSessions.attach');
    expect((RPC_METHODS as any).DAEMON_DIRECT_SESSION_DETACH).toBe('daemon.directSessions.detach');
    expect((RPC_METHODS as any).DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET).toBe('daemon.directSessions.followPolicy.set');
    expect((RPC_METHODS as any).DAEMON_DIRECT_SESSION_STATUS_GET).toBe('daemon.directSessions.status.get');
    expect((RPC_METHODS as any).DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE).toBe('daemon.directSessions.transcript.page');
    expect((RPC_METHODS as any).DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER).toBe('daemon.directSessions.transcript.readAfter');
    expect((RPC_METHODS as any).DAEMON_DIRECT_SESSION_TAKEOVER).toBe('daemon.directSessions.takeover');
    expect((RPC_METHODS as any).DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST).toBe('daemon.directSessions.takeoverPersist');
  });
});
