import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
export type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
export type PluginContributionRef = Readonly<{ pluginId: string; localId: string }>;
export interface Disposable {
    dispose(): void | Promise<void>;
}

/**
 * Cancellation for one host call.
 *
 * The signal is honoured for the WHOLE in-flight window, not only when the call
 * is admitted: aborting it retires whatever the host is still holding for the
 * request — a confirmation dialog is dismissed — and the call rejects with a
 * typed host error instead of settling. An outward effect the host already
 * completed stays settled, so a late abort never invites a blind retry of a
 * mutation that already ran.
 */
export type PluginCancellationOptions = Readonly<{
    signal?: AbortSignal;
}>;

export type PluginTargetedContributionSourceCustodyV1 =
    | Readonly<{
        kind: 'managed';
        immutableGenerationId: string;
        installSource: 'npm' | 'archive' | 'localPath';
    }>
    | Readonly<{
        kind: 'bundled_first_party';
        packagedRuntime: Readonly<
            | { kind: 'cli_version_root'; versionRootId: string }
            | { kind: 'pinned_runner_snapshot'; snapshotId: string }
            | { kind: 'source_declaration'; packageName: string }
        >;
    }>
    | Readonly<{
        kind: 'development';
        registeredRootId: string;
    }>
    | Readonly<{
        kind: 'account_release';
        pluginId: string;
        version: string;
        archiveDigestSha256: string;
    }>;


/** @moduleRealm any */

/**
 * The descriptive, non-executable identity of one target-owned admitted
 * operation. It deliberately omits the underlying qualified Action ref: only
 * the host-created opaque handle can execute it.
 */
export type AdmittedTargetedOperationIdentity<TRole extends string = string> = Readonly<{
  target: Readonly<{
    pluginId: string;
  }>;
  point: Readonly<{
    pointId: string;
    protocol: Readonly<{
      id: string;
      version: number;
    }>;
  }>;
  contributor: Readonly<{
    pluginId: string;
    contributionId: string;
    occurrenceId: string;
    sourceCustody: PluginTargetedContributionSourceCustodyV1;
  }>;
  role: TRole;
}>;

/**
 * An exact-occurrence execution capability with durable source custody,
 * projected from an admitted target-owned operation. Its identity may be copied for display or
 * comparison, but only the original host-created handle can execute. The
 * required declaration-only projection retains exact input/result types while
 * remaining structurally compatible across independently installed SDK copies.
 */
export declare abstract class AdmittedTargetedOperationExecutionHandle<
  TInput extends JsonValue = JsonValue,
  TResult extends JsonValue | void = JsonValue | void,
  TRole extends string = string,
> {
  readonly typeProjection: Readonly<{
    readonly input: TInput;
    readonly result: TResult;
  }> | undefined;
  readonly identity: AdmittedTargetedOperationIdentity<TRole>;
}

/**
 * One target-owned point declaration used to observe its admitted contributors.
 * The host only accepts it for the invoking target plugin; it is not a global
 * catalog query or an authority to inspect another target's point.
 */
export type TargetedContributionPointRef<TContribution = unknown> = Readonly<{
    /**
     * The declaration's owning target. This is an equality fence against the
     * invoking plugin identity, not a selector for another target's catalog.
     */
    targetPluginId: string;
    id: string;
    protocol: Readonly<{
        id: string;
        version: number;
    }>;
    /** Compile-time evidence only; no contributor implementation crosses the manifest boundary. */
    readonly __targetedContribution?: TContribution;
}>;

/**
 * A complete current admitted view of one target-owned point.
 */
export interface TargetedContributionSnapshot<TContribution> {
    readonly occurrenceId: string;
    readonly sourceCustody: PluginTargetedContributionSourceCustodyV1;
    readonly contributions: readonly TContribution[];
}

/** A reserve-before-read observation of one target point's current admitted view. */
export interface TargetedContributionObservation<TContribution> extends Disposable {
    readCurrent(options?: PluginCancellationOptions): Promise<TargetedContributionSnapshot<TContribution>>;
}

/**
 * Target-local admitted-contribution discovery. The callback is level-triggered:
 * it carries no delta and callers reread a complete bounded current snapshot.
 */
export interface TargetedContributionsService {
    observeForSelf<TContribution>(
        point: TargetedContributionPointRef<TContribution>,
        options: Readonly<{ onInvalidated: () => void }>,
    ): TargetedContributionObservation<TContribution>;
}


export type PluginActionReadInvalidation = (() => void) & Readonly<{ retire(): void }>;
export type PluginActionReadObserver<I extends JsonValue = JsonValue, TContext = unknown> = (
  input: I, invalidate: PluginActionReadInvalidation, context: TContext,
) => Disposable | Promise<Disposable>;
