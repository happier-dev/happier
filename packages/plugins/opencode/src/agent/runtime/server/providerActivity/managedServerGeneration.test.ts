import { describe, expect, it } from 'vitest';

import type { ManagedServerSnapshotV1 } from '@happier-dev/plugin-sdk';

import {
  describeOpenCodeManagedServerGenerationForLog,
  isSameOpenCodeManagedServerGeneration,
  resolveOpenCodeManagedServerGenerationIdentity,
} from './managedServerGeneration.js';

function snapshot(overrides: Partial<ManagedServerSnapshotV1> = {}): ManagedServerSnapshotV1 {
  return {
    id: 'opencode-server',
    state: 'healthy',
    mode: 'managed-spawn',
    baseUrl: 'http://127.0.0.1:49196',
    port: 49196,
    credentialEnvKey: 'OPENCODE_SERVER_PASSWORD',
    pid: 100,
    startedAt: 1000,
    lastHealthyAt: 1200,
    ...overrides,
  } as ManagedServerSnapshotV1;
}

describe('resolveOpenCodeManagedServerGenerationIdentity', () => {
  it('is stable across health pulses (lastHealthyAt is excluded)', () => {
    const a = resolveOpenCodeManagedServerGenerationIdentity(snapshot({ lastHealthyAt: 1200 }));
    const b = resolveOpenCodeManagedServerGenerationIdentity(snapshot({ lastHealthyAt: 9999 }));
    expect(a.generationKey).toBe(b.generationKey);
    expect(isSameOpenCodeManagedServerGeneration(a, b)).toBe(true);
  });

  it('changes the generation key when the process is replaced (pid/startedAt/baseUrl)', () => {
    const a = resolveOpenCodeManagedServerGenerationIdentity(snapshot({}));
    const replaced = resolveOpenCodeManagedServerGenerationIdentity(
      snapshot({ pid: 200, startedAt: 2000, baseUrl: 'http://127.0.0.1:49197', port: 49197 }),
    );
    expect(a.generationKey).not.toBe(replaced.generationKey);
    expect(isSameOpenCodeManagedServerGeneration(a, replaced)).toBe(false);
  });

  it('treats null/null as same and null/present as different', () => {
    const present = resolveOpenCodeManagedServerGenerationIdentity(snapshot({}));
    expect(isSameOpenCodeManagedServerGeneration(null, null)).toBe(true);
    expect(isSameOpenCodeManagedServerGeneration(null, present)).toBe(false);
    expect(isSameOpenCodeManagedServerGeneration(present, null)).toBe(false);
  });

  it('produces a redacted, truncated log summary with no credential values', () => {
    const identity = resolveOpenCodeManagedServerGenerationIdentity(snapshot({}));
    const summary = describeOpenCodeManagedServerGenerationForLog(identity);
    expect(summary.generationKey).toBe(identity.generationKey.slice(0, 12));
    expect(JSON.stringify(summary)).not.toContain('OPENCODE_SERVER_PASSWORD');
    expect(describeOpenCodeManagedServerGenerationForLog(null)).toEqual({ present: false });
  });
});
