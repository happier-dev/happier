/** One caller's claim on a host-owned, plugin-local ephemeral value. */
export type PluginEphemeralSharedValueLease<T> = Readonly<{
    value: T;
    release(): void;
    /** Withdraw this exact value for every borrower. A stale lease cannot retire its replacement. */
    retire?(): void;
}>;

/**
 * The opaque host-owned sharing seam for one Account, plugin, and immutable
 * plugin generation.
 *
 * `localKey` is plugin-local and should be versioned when the value shape
 * changes. A retired scope refuses acquisition with `null`; callers must not
 * replace that refusal with an artifact-local cache or global fallback.
 */
export type PluginEphemeralSharedScope = Readonly<{
    acquire<T>(
        localKey: string,
        create: () => Readonly<{
            value: T;
            dispose(): void;
            /** Preserve the value after its last lease is released. */
            retainWhenIdle?: true;
            /** Stop subscriptions and other live work when a retained value becomes idle. */
            onIdle?(): void;
            /** The active transport changed while the shared value survived. */
            onExecutionOriginChange?(): void;
        }>,
    ): PluginEphemeralSharedValueLease<T> | null;
    /**
     * Share only with borrowers on this mount's exact admitted execution origin.
     * The host qualifies the existing value namespace without exposing executor
     * custody. No admitted origin, or a retired scope, returns null. Older hosts
     * omit this operation; an execution-bound consumer must then stay unavailable.
     * Credential selection remains the invoking domain's admission contract.
     */
    acquireExecutionBound?: PluginEphemeralSharedScope['acquire'];
}>;
