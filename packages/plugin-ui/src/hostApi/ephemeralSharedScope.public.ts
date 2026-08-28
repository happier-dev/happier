/**
 * One caller's claim on a host-owned, plugin-local ephemeral value.
 *
 * The value is deliberately opaque to the host. Releasing the lease only
 * drops this caller's claim; the scope owner disposes the value when its final
 * lease is released or when the bound Account/plugin/generation retires.
 */
export type PluginUiEphemeralSharedValueLease<T> = Readonly<{
  value: T;
  release(): void;
}>;

/**
 * The optional host-owned sharing seam between artifacts of one plugin
 * generation in one Account lifetime.
 *
 * `localKey` is plugin-local and should be versioned by the plugin when its
 * value shape changes. `create` runs only when the scope has no live value for
 * that key. Acquire only from a committed effect, subscription or event
 * lifecycle, never during React render, so every lease has a cleanup owner. A
 * retired scope refuses acquisition with `null`; callers must not replace that
 * refusal with an artifact-local cache or global fallback.
 */
export type PluginUiEphemeralSharedScope = Readonly<{
  acquire<T>(
    localKey: string,
    create: () => Readonly<{ value: T; dispose(): void }>,
  ): PluginUiEphemeralSharedValueLease<T> | null;
}>;
