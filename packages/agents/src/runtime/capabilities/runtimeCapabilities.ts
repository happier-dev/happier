import type { RuntimeControlSurface } from '../engine/contracts.js';

export type RuntimeExecutionRunCapabilities = Readonly<{
  supported: boolean;
}>;

/**
 * Published live runtime support stays aligned with the materialized runtime control surface today.
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
  /** Live runtime correlation of background tasks and their originating tool contexts. */
  providerContinuations?: Readonly<{ supported: true }>;
  /** Concrete dispatcher support; declaration/catalog defaults are not live facts. */
  backend?: Readonly<{
    session?: Readonly<{
      media?: Readonly<{
        acceptsImageInput?: Readonly<{ supported: boolean }>;
      }>;
    }>;
  }>;
}>;
