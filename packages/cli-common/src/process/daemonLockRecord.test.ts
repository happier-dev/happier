import { describe, expect, it } from 'vitest';
import { parseDaemonLockSnapshot } from './daemonLockRecord';

describe('daemon lock ingress', () => {
  it('preserves strict current identity and only the observed numeric predecessor liveness shape', () => {
    const record = { t: 'happier_daemon_lock_v2', pid: 42,
      ownerToken: '00000000-0000-4000-8000-000000000001', processStartedAtMs: 1,
      createdAtMs: 2, processInstanceFingerprint: 'birth:42' };
    const raw = JSON.stringify(record);
    expect(parseDaemonLockSnapshot(raw)).toEqual({ raw, pid: 42, record });
    expect(parseDaemonLockSnapshot('42\n')).toEqual({ raw: '42\n', pid: 42, record: null });
    for (const invalid of [{ ...record, ownerToken: 'invalid' }, { ...record, extra: true },
      { ...record, t: 'happier_daemon_lock_v1' }]) {
      expect(parseDaemonLockSnapshot(JSON.stringify(invalid))).toMatchObject({ pid: null, record: null });
    }
  });
});
