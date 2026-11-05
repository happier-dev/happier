import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { PluginAccountStorageConsumerContext } from '@happier-dev/plugin-sdk/storage';
import type { TriageRetainedSessionRelationsUpgrade } from '../sessions/retainedSessionRelationsUpgrade.js';

/** Portable data capabilities, accepting the daemon's guarded Account storage too. */
export type TriageDataActionContext = Omit<PluginAccountActionContext, 'services'> & Readonly<{
  services: Omit<PluginAccountActionContext['services'], 'storage'> & PluginAccountStorageConsumerContext['services'];
  /** Bound only by the real portable Account activation, never caller data. */
  sessionRelationsUpgrade?: TriageRetainedSessionRelationsUpgrade;
}>;

export type TriageDataActionHandler<
  I extends JsonValue = JsonValue,
  O extends JsonValue | void = JsonValue | void,
> = (input: I, context: TriageDataActionContext) => O | Promise<O>;
