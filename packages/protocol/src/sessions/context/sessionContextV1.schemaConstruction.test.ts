import { describe, expect, it, vi } from 'vitest';

// Counts Zod schema construction (the library boundary). Every builder still runs the real
// implementation; only the number of builder calls is observed.
const builds = vi.hoisted(() => ({ count: 0 }));
vi.mock('zod/mini', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown> & { z: Record<string, unknown> }>();
  const count = (namespace: Record<string, unknown>) => Object.fromEntries(Object.entries(namespace).map(([name, value]) => [
    name,
    typeof value === 'function' && /^[a-z]/.test(name)
      ? (...args: unknown[]) => { builds.count += 1; return (value as (...a: unknown[]) => unknown)(...args); }
      : value,
  ]));
  return { ...count(actual), z: count(actual.z) };
});

// The shared Vitest setup already imported Protocol's Zod policy; load a fresh graph under the counter.
vi.resetModules();
const { migrateRetainedSessionMetadataContextV1, migrateRetainedSessionWorkContextV1 } = await import('./sessionContextV1.js');

describe('retained Session context migration', () => {
  // The daemon and the memory worker run this for every Session metadata decode
  // (2,039 Sessions × several readers per pass on a production-shaped Account).
  it('builds no schema per decoded Session after the first decode', () => {
    const work = { memoryEnabled: true, sessionRolesV1: { overrides: {}, sessionRoles: {} }, promptStack: [] };
    const legacy = { work: { sessionRolesV1: { memoryDocRef: { kind: 'doc', artifactId: 'doc-1' } } } };
    migrateRetainedSessionWorkContextV1(work);
    migrateRetainedSessionMetadataContextV1(legacy);
    const before = builds.count;
    expect(before).toBeGreaterThan(0);
    for (let index = 0; index < 100; index += 1) {
      expect(migrateRetainedSessionWorkContextV1(work)).toEqual(work);
      migrateRetainedSessionMetadataContextV1(legacy);
    }
    expect(builds.count - before).toBe(0);
    expect(migrateRetainedSessionMetadataContextV1(legacy)).toEqual({ work: {
      sessionRolesV1: {},
      promptStack: [{ id: 'session.legacy-role-memory', ref: { kind: 'doc', artifactId: 'doc-1' }, enabled: true, placement: 'system_append' }],
    } });
  });
});
