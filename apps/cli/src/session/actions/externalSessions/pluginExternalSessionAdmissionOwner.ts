import type {
  ExternalSessionPluginMaterializeStart,
} from './materializeStartAction';
import type {
  PluginSessionHookManagementActionExecutor,
} from './pluginSessionHookManagementActionExecutor';
import type {
  ExternalSessionPluginTakeoverStartActionExecutor,
} from './takeoverStartAction';

export type ExternalSessionPluginTakeoverStart =
  ExternalSessionPluginTakeoverStartActionExecutor['startPluginTakeover'];

/**
 * CLI-private bridge from plugin-authored action admission to the canonical
 * durable External Sessions operation owners. Each callback retains its
 * distinct semantic input and response contract; this object only removes
 * duplicate production plumbing.
 */
export type ExternalSessionPluginAdmissionOwner = Readonly<{
  materializeStart?: ExternalSessionPluginMaterializeStart;
  takeoverStart?: ExternalSessionPluginTakeoverStart;
  hookManagementAction?: PluginSessionHookManagementActionExecutor['execute'];
}>;
