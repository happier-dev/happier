/** @moduleRealm any */
import type { JsonValue } from '../identity.js';

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
    immutableGenerationId: string;
  }>;
  role: TRole;
}>;

/**
 * An exact-generation execution capability projected from an admitted
 * target-owned operation. Its identity may be copied for display or
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
