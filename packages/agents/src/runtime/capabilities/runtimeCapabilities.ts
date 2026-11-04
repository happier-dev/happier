import type { RuntimeControlSurface } from '../engine/contracts.js';

export type RuntimeExecutionRunCapabilities = Readonly<{
  supported: boolean;
}>;

/**
 * Published live runtime support stays aligned with the materialized runtime control surface today.
 * Execution runs and provider continuations add live support beyond that control surface.
 * `transcriptSource` stays outside this type on `RuntimeFacets`; do not infer a richer generic
 * capability/facet family from this published shape.
 */
export type RuntimeCapabilities = Readonly<{
  localControl?: RuntimeControlSurface['localControl'] | null;
  sessionStorage?: RuntimeControlSurface['sessionStorage'] | null;
  sessionCapabilities?: RuntimeControlSurface['sessionCapabilities'] | null;
  tools?: RuntimeControlSurface['tools'] | null;
  handoff?: RuntimeControlSurface['handoff'] | null;
  executionRun?: RuntimeExecutionRunCapabilities | null;
  /** The runtime correlates live background tasks and explicitly releases their originating tool contexts. */
  providerContinuations?: Readonly<{ supported: true }>;
}>;
