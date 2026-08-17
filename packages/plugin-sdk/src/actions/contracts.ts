import type { JsonValue, PluginContributionRef } from '../identity.js';
import type { PluginInvocationContext } from '../invocation.js';

/** A contributed Action's complete runtime reference, with no hidden type evidence. */
export type ActionContract = PluginContributionRef;

/**
 * Handler for one manifest-declared Action contribution.
 * @realm daemon
 */
export type ActionHandler<
  I extends JsonValue = JsonValue,
  O extends JsonValue | void = JsonValue | void,
> = (input: I, context: PluginInvocationContext) => O | Promise<O>;
