/** Shared leaf owner: routing and invocation schemas must use the same kinds. */
export const DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_INVOCATION_KINDS_V1 = {
  hostPresentedComposer: 'hostPresentedComposer',
  hostPresentedMessage: 'hostPresentedMessage',
  mountedPluginSurface: 'mountedPluginSurface',
  clientPluginAction: 'clientPluginAction',
} as const;
