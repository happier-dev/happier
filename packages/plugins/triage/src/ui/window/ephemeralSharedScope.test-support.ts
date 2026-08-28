import type { PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';

/**
 * Host-owned Account/plugin/generation scope for mounted Triage surface tests.
 *
 * Tests keep one fixture for every artifact mount that is meant to share the
 * live list window. The final released lease disposes the opaque plugin value,
 * matching the host lifetime contract without teaching the fixture anything
 * about Triage's value shape.
 */
export function createTriageEphemeralSharedScopeFixture(): PluginUiEphemeralSharedScope {
  const values = new Map<string, { value: unknown; dispose(): void; leases: number }>();

  return Object.freeze({
    acquire<T>(key: string, create: () => Readonly<{ value: T; dispose(): void }>) {
      let entry = values.get(key);
      if (entry === undefined) {
        const created = create();
        entry = { value: created.value, dispose: created.dispose, leases: 0 };
        values.set(key, entry);
      }
      entry.leases += 1;
      let released = false;
      return Object.freeze({
        value: entry.value as T,
        release() {
          if (released) return;
          released = true;
          entry!.leases -= 1;
          if (entry!.leases > 0 || values.get(key) !== entry) return;
          values.delete(key);
          entry!.dispose();
        },
      });
    },
  });
}
