import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { PluginAccountStorageConsumerContext } from '@happier-dev/plugin-sdk/storage';

/** Portable data capabilities, accepting the daemon's guarded Account storage too. */
export type TriageDataActionContext = Omit<PluginAccountActionContext, 'services'> & Readonly<{
  services: Omit<PluginAccountActionContext['services'], 'storage'> & PluginAccountStorageConsumerContext['services'];
}>;

export type TriageDataActionHandler<
  I extends JsonValue = JsonValue,
  O extends JsonValue | void = JsonValue | void,
> = (input: I, context: TriageDataActionContext) => O | Promise<O>;
