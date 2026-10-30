
/** Action identity leaf: schema modules and the registry share these constants. */
export const PLUGIN_WEBHOOK_ACTION_IDS_V1 = Object.freeze([
  'plugin.webhook.endpoint.ensure',
  'plugin.webhook.endpoint.read',
  'plugin.webhook.endpoint.revoke',
  'plugin.webhook.endpoint.retarget',
  'plugin.webhook.endpoint.checkCorrespondence',
  'plugin.webhook.endpoint.convergeTarget',
  'plugin.webhook.delivery.movePending',
  'plugin.webhook.delivery.replay',
  'plugin.webhook.delivery.discard',
  'plugin.webhook.endpoint.credential.configure',
  'plugin.webhook.endpoint.credential.rotate',
  'plugin.webhook.endpoint.credential.finishRotation',
] as const);
/**
 * The closed set of endpoint operations a host-stamped plugin caller may run.
 * Every other endpoint operation stays present-user, and this one list is what
 * the Action registry, the CLI caller-surface guard, and the server plugin
 * route family all derive from.
 */
export const PLUGIN_WEBHOOK_PLUGIN_SURFACE_ACTION_IDS_V1 = Object.freeze([
  'plugin.webhook.endpoint.checkCorrespondence',
  'plugin.webhook.endpoint.convergeTarget',
] as const);
