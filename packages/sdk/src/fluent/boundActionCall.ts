import { PUBLIC_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/actionSpecs';

import type { PublicActionId, PublicActionInputById } from '../actions/generated.js';
import { HappierActionError } from '../errors.js';
import type { ActionExecutionOptions } from '../types.js';

type PublicActionInputParser = Readonly<{
  safeParse(value: unknown):
    | Readonly<{ success: true; data: unknown }>
    | Readonly<{ success: false; error: Readonly<{
        issues: readonly Readonly<{ path: readonly PropertyKey[]; code: string }>[];
      }> }>;
}>;

// This dynamic lookup consumes the parser contract, not the union of every
// Action's Zod internals. The public generic below preserves caller correlation.
const PUBLIC_ACTION_INPUT_PARSERS: Readonly<Record<PublicActionId, PublicActionInputParser>> = PUBLIC_ACTION_INPUT_SCHEMAS;

/**
 * Physical routing and cancellation for a fluent handle's internal
 * correspondence lookup. A caller's request identity stays with the one Action
 * they named, so two distinct Actions never reuse the same correlation id.
 */
export function correspondenceOptions(
  options: ActionExecutionOptions | undefined,
): ActionExecutionOptions | undefined {
  if (options === undefined) return undefined;
  return {
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

/**
 * A fluent handle writes its bound identity last and then hands the canonical
 * Action its own public input schema. Type-level omission cannot constrain
 * plain JavaScript, so an unknown or host-only field fails here — with the
 * daemon's own `invalid_parameters` vocabulary — instead of travelling inside
 * a sealed request body. This adds no SDK schema: `PUBLIC_ACTION_INPUT_SCHEMAS`
 * is the same Protocol projection the executor's `api` surface validates with.
 */
export function bindPublicActionInput<K extends PublicActionId>(
  actionId: K,
  input: PublicActionInputById[K],
  requestId?: string,
): PublicActionInputById[K] {
  const parsed = PUBLIC_ACTION_INPUT_PARSERS[actionId].safeParse(input);
  // The action id selects the matching schema above, but TypeScript cannot
  // retain that correlation across the generated Action-map union.
  if (parsed.success) return parsed.data as PublicActionInputById[K];
  throw new HappierActionError(
    'invalid_parameters',
    `The ${actionId} input is not valid on the public Happier API surface.`,
    // Paths and issue codes only: a rejected body may carry user content.
    parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
    requestId,
  );
}
