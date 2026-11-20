import { z } from '../../zodRuntimePolicy.js';
import { SESSION_CONFIG_OPTION_SET_ACTION_ID_V1, SESSION_CONNECTED_SERVICE_AUTH_SET_ACTION_ID_V1, SESSION_TARGET_PRIMARY_SET_ACTION_ID_V1, type ActionId } from '../actionIds.js';
import { type ActionContextualDefaults } from '../contextualDefaults.js';


export const CURRENT_SESSION_CONTEXT_ACTION_IDS = new Set<ActionId>([
  'session.needs_you.raise',
  'reviews.comments.create',
  'browser.recording.attachToComposer',
  'localServices.inventory.list',
  'localServices.inventory.refresh',
  'localServices.launcher.snapshot',
  'localServices.launcher.openPreview',
  'localServices.launcher.registerPreview',
  'localServices.launcher.history.clear',
  'localServices.preview.openOrCreate',
  'localServices.preview.status',
  'localServices.preview.revoke',
  'localServices.publicPreview.create',
  'localServices.publicPreview.status',
  'localServices.publicPreview.revoke',
  'localServices.publicPreview.copyUrl',
  'peerMediation.observability.snapshot',
  'sessions.external.operation.status.get',
  'sessions.external.operation.cancel',
  'sessions.external.operation.resume',
  'sessions.external.operation.retry',
  'sessions.external.operation.discard',
  'action.options.resolve',
  'review.start',
  'review.walkthrough',
  'review.explain_findings',
  'subagents.plan.start',
  'subagents.delegate.start',
  'voice_agent.start',
  'execution.run.start',
  'execution.run.list',
  'execution.run.get',
  'execution.run.send',
  'execution.run.ensure',
  'execution.run.ensure_or_start',
  'execution.run.stream.start',
  'execution.run.stream.read',
  'execution.run.stream.cancel',
  'execution.run.stop',
  'execution.run.cancel_turn',
  'execution.run.action',
  'execution.run.wait',
  'session.open',
  'session.fork',
  'session.rollback',
  'session.checkpoint_code_rollback',
  'session.checkpoint',
  'session.restore',
  'session.handoff',
  'session.handoff.prepare_target',
  'review.engines.list',
  'session.message.send',
  'session.turn.cancel',
  'session.compact',
  'session.stop',
  'session.runtime.refresh',
  'session.control.switch',
  'session.terminalComposer.clear',
  'session.pendingInput.interruptAndRun',
  'session.pending.edit',
  'session.title.set',
  'session.bot.set',
  'session.bot.face.set',
  'session.organization.pin.set',
  'session.view.toolCalls.set',
  'session.memory.set',
  'session.voice.preference.set',
  'session.context.update',
  'session.instructions.set',
  'session.permission_mode.set',
  'session.approval_reviewer.set',
  'session.attention.set',
  'session.model.set',
  'session.archive',
  'session.unarchive',
  'session.status.get',
  'session.work_state.get',
  'session.goal.get',
  'session.goal.set',
  'session.goal.clear',
  'session.usageLimit.waitResume.enable',
  'session.usageLimit.waitResume.cancel',
  'session.usageLimit.checkNow',
  'session.usageLimit.consumeResetCredit',
  'session.vendor_plugin_catalog.list',
  'session.skill_catalog.list',
  'session.history.get',
  'session.transcript.get',
  'session.events.get',
  'session.wait.idle',
  'session.board.get',
  'session.board.item.upsert',
  'session.board.item.remove',
  'session.board.layout.update',
  'session.permission.respond',
  'session.permission.remote.pending.list',
  'session.permission.remote.respond',
  'session.user_action.remote.answer',
  'session.permission.remote.grants.list',
  'session.permission.remote.grants.revoke',
  'session.user_action.answer',
  'session.mode.set',
  SESSION_CONFIG_OPTION_SET_ACTION_ID_V1,
  SESSION_CONNECTED_SERVICE_AUTH_SET_ACTION_ID_V1,
  SESSION_TARGET_PRIMARY_SET_ACTION_ID_V1,
  'session.activity.get',
  'session.messages.recent.get',
  'ui.voice_agent.teleport',
  'memory.ensure_up_to_date',
  'transcript.page',
  'transcript.readAfter',
  'transcript.follow',
  'transcript.unfollow',
  'transcript.import',
  'transcript.search',
  'sessions.external.follow',
  'sessions.external.unfollow',
  'sessions.external.backgroundFollow.set',
  'sessions.external.status.get',
]);

/** Only required top-level targets default; optional filters and nested destinations keep their owner's semantics. */
function requiresMachineTarget(schema: z.core.$ZodType): boolean {
  if (schema instanceof z.core.$ZodObject) {
    const machineId = schema._zod.def.shape.machineId;
    return machineId !== undefined && !z.safeParse(machineId, undefined).success;
  }
  if (schema instanceof z.core.$ZodIntersection) {
    return requiresMachineTarget(schema._zod.def.left) || requiresMachineTarget(schema._zod.def.right);
  }
  if (schema instanceof z.core.$ZodPipe) {
    // A preprocessing transform delegates the accepted shape to its output parser.
    return requiresMachineTarget(schema._zod.def.in instanceof z.core.$ZodTransform
      ? schema._zod.def.out : schema._zod.def.in);
  }
  if (schema instanceof z.core.$ZodUnion) return schema._zod.def.options.every(requiresMachineTarget);
  return false;
}

export function resolveBuiltInActionContextualDefaults(actionId: ActionId, inputSchema: z.core.$ZodType): ActionContextualDefaults | undefined {
  const sessionId = CURRENT_SESSION_CONTEXT_ACTION_IDS.has(actionId) ? 'current_session' as const : undefined;
  // get_window intentionally defaults its optional Machine operand as well.
  const machineId = requiresMachineTarget(inputSchema) || actionId === 'memory.get_window'
    ? 'current_session_machine' as const : undefined;
  return sessionId || machineId ? { ...(sessionId ? { sessionId } : {}), ...(machineId ? { machineId } : {}) } : undefined;
}
