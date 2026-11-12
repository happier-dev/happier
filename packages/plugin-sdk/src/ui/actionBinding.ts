import type { PluginUiActionBinding as CanonicalActionBinding } from '@happier-dev/cli-common/plugins/ui';
import type { PluginUiActionReference } from './hostApi.js';

/** A host-owned inline commit; preparation never receives execution authority. */
export type PluginUiActionBinding<Value, Key extends string = string> = CanonicalActionBinding<Value, Key, PluginUiActionReference>;
