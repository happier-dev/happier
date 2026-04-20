import type { RuntimeControlSurface } from '../engine/contracts.js';

export type RuntimeExecutionRunCapabilities = Readonly<{
  supported: boolean;
}>;

/**
 * Published live runtime support stays aligned with the materialized runtime control surface today.
 * Execution-run support is the only additional shared capability family currently surfaced here.
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
}>;
