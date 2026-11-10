import type { ActionPluginCallerPolicy, ActionSpecWithoutApproval } from './definition.js';
import { isRuntimeActionIdV1, type ActionId } from '../actionIds.js';


export const HOST_DOMAIN_PLUGIN_CALLER_POLICY: ActionPluginCallerPolicy = {
  kind: 'caller',
};
export const PLUGIN_RELOAD_CALLER_POLICY: ActionPluginCallerPolicy = {
  kind: 'self_or_inspector_admin',
  targetPluginIdField: 'pluginId',
  administrativeCallers: [{
    pluginId: 'happier.inspector',
    contributionLocalId: 'inspector-app',
  }],
};
/**
 * The one declaration census for host Actions with a caller policy on the
 * plugin surface.
 * `caller` means the canonical executor requires a current host-stamped
 * plugin caller. A `caller` row names no plugin identity: a built-in plugin
 * and an out-of-tree plugin reach exactly the same host capability. Further
 * identity projection occurs only when the incumbent domain owner has
 * caller-dependent authorization — Account scope, publisher proof, and current
 * materialization are that owner's fences, and they do not depend on which
 * plugin is asking. Reload is the one plugin-*targeted* Action: it administers
 * a peer plugin's development generation, so its self scope and the exact
 * Inspector administrative surface live here rather than in any consumer.
 */
export const ACTION_PLUGIN_CALLER_POLICY_BY_ID: Readonly<
  Partial<Record<ActionId, ActionPluginCallerPolicy>>
> = Object.freeze({
  'action.invoke': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'action.operations.get': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'machines.managed.list': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'connectedServices.quota.get': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'connectedServices.billing.open': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'connectedServices.pools.selection.get': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'discussion.get': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'deployments.environments.list': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.query': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.prices.get': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.prices.refresh': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.export': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.recap.compose': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.recap.export': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.recap.deliver': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.recap.private.compose': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.recap.private.export': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.recap.private.deliver': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.calendar.export': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.coach.apply': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.coach.undo': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.coach.dismiss': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'usage.coach.snooze': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'capture.view': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.reload': PLUGIN_RELOAD_CALLER_POLICY,
  'plugins.permissions.grants.request': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.permissions.grants.revoke': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.event.admit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.event.source.status.report': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.conversation.targets.list': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.conversation.target.verify': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'automation.conversation.admit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.create': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.transition': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.edit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.reply': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.redact': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.setDisposition': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.attachEvidence': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.bulkTransition': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'reviews.comments.claimPublicationDispatch': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'browser.navigate': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.install': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.disable': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.enable': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'plugins.sessionHooks.uninstall': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.materialize.start': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.cancel': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.resume': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.retry': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.operation.discard': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  // Destructive Board removal needs a current host-stamped plugin caller; the
  // Session's own access owner still authorizes the record mutation beneath it.
  'session.board.item.remove': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.rollback': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.checkpoint_code_rollback': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.checkpoint': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.restore': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.terminalComposer.clear': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pendingInput.interruptAndRun': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pending.action.set': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pending.edit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pending.sendNow': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pending.requeue': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pending.withdraw': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pending.markHandled': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pending.dismiss': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.pending.sendAsNew': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.usageLimit.consumeResetCredit': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'agents.acp.backends.upsert': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'agents.acp.backends.get': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'agents.acp.backends.delete': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'agents.acp.backends.installFromRegistry': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_doc.update': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_doc.get': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_doc.create': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_doc.favorite.set': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'models.favorite.set': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'session.model.unarm': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompts.library.list': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompts.stack.update': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompts.invocations.list': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompts.invocation.resolve': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompts.invocation.create': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_bundle.update': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'prompt_registry.install': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'transcript.import': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'sessions.external.backgroundFollow.set': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.openOrReuse': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.checkout': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.prepareWorktree': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.reviewWorkspace.materializePrepared': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.pullRequest.runStacked': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.repository.clone': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.repository.init': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.repository.removeIndexLock': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
  'scm.hostingRepository.publish': HOST_DOMAIN_PLUGIN_CALLER_POLICY,
});

export function resolveActionPluginCallerPolicy(
  spec: ActionSpecWithoutApproval,
): ActionPluginCallerPolicy | undefined {
  const policy = ACTION_PLUGIN_CALLER_POLICY_BY_ID[spec.id];
  const requiresPolicy = spec.surfaces.plugin && spec.safety !== 'safe';
  if (!spec.surfaces.plugin && policy) {
    throw new Error(`Action ${spec.id} declares pluginCallerPolicy without a plugin surface`);
  }
  // Backed runtime Actions use the same host-stamped Plugin provenance as
  // every other non-safe host Action. Their machine/session routing remains
  // with the runtime owner; callers never supply a plugin identity in input.
  if (requiresPolicy && isRuntimeActionIdV1(spec.id)) {
    return HOST_DOMAIN_PLUGIN_CALLER_POLICY;
  }
  return requiresPolicy ? policy ?? HOST_DOMAIN_PLUGIN_CALLER_POLICY : policy;
}
