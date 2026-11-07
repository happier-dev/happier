import type { PluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';

type SharedValueEntry = {
  value: unknown;
  dispose(): void;
  retainWhenIdle: boolean;
  onIdle?: () => void;
  onExecutionOriginChange?: () => void;
  readonly leases: Set<Readonly<{ executionOriginKey: string }>>;
};

/**
 * One Account/plugin/generation fixture with independently mounted transport
 * origins. Each returned scope is a distinct host facade, while their opaque
 * values remain generation-shared exactly like the product registry.
 */
export function createTriageEphemeralSharedScopeOriginFixture(): Readonly<{
  forExecutionOrigin(executionOriginKey: string): PluginUiEphemeralSharedScope;
  /** The host retires the scope (Account or plugin occurrence): every value is disposed. */
  retire(): void;
}> {
  const values = new Map<string, SharedValueEntry>();
  let retired = false;

  return Object.freeze({
    retire() {
      retired = true;
      const entries = [...values.values()];
      values.clear();
      for (const entry of entries) entry.dispose();
    },
    forExecutionOrigin(executionOriginKey: string): PluginUiEphemeralSharedScope {
      const scope: PluginUiEphemeralSharedScope = Object.freeze({
        acquire<T>(key: string, create: () => Readonly<{
          value: T;
          dispose(): void;
          retainWhenIdle?: true;
          onIdle?(): void;
          onExecutionOriginChange?(): void;
        }>) {
          if (retired) return null;
          let entry = values.get(key);
          if (entry === undefined) {
            const created = create();
            entry = {
              value: created.value,
              dispose: created.dispose,
              retainWhenIdle: created.retainWhenIdle === true,
              ...(created.onIdle === undefined ? {} : { onIdle: created.onIdle }),
              ...(created.onExecutionOriginChange === undefined
                ? {}
                : { onExecutionOriginChange: created.onExecutionOriginChange }),
              leases: new Set(),
            };
            values.set(key, entry);
          }
          const leaseRecord = Object.freeze({ executionOriginKey });
          entry.leases.add(leaseRecord);
          let released = false;
          return Object.freeze({
            value: entry.value as T,
            release() {
              if (released) return;
              released = true;
              const activeBeforeRelease = entry!.leases.values().next().value as
                | Readonly<{ executionOriginKey: string }>
                | undefined;
              entry!.leases.delete(leaseRecord);
              if (entry!.leases.size === 0) {
                if (values.get(key) !== entry) return;
                // The SDK contract: a retained value survives its last lease.
                if (entry!.retainWhenIdle) {
                  entry!.onIdle?.();
                  return;
                }
                values.delete(key);
                entry!.dispose();
                return;
              }
              const activeAfterRelease = entry!.leases.values().next().value as
                | Readonly<{ executionOriginKey: string }>
                | undefined;
              if (
                activeBeforeRelease === leaseRecord
                && activeAfterRelease?.executionOriginKey !== executionOriginKey
              ) {
                entry!.onExecutionOriginChange?.();
              }
            },
          });
        },
      });
      const acquireExecutionBound: PluginUiEphemeralSharedScope['acquire'] = (key, create) =>
        scope.acquire(JSON.stringify(['execution', executionOriginKey, key]), create);
      return Object.freeze({ ...scope, acquireExecutionBound });
    },
  });
}

/**
 * Host-owned Account/plugin/generation scope for mounted Triage surface tests.
 *
 * Tests keep one fixture for every artifact mount that is meant to share the
 * live list window. The final released lease disposes the opaque plugin value,
 * matching the host lifetime contract without teaching the fixture anything
 * about Triage's value shape.
 */
export function createTriageEphemeralSharedScopeFixture(): PluginUiEphemeralSharedScope {
  return createTriageEphemeralSharedScopeOriginFixture().forExecutionOrigin('fixture');
}
