import { z } from 'zod';

export const ACTION_IDS = [
  // Action discovery
  'action.spec.search',
  'action.spec.get',
  'action.options.resolve',
  // Session lifecycle / navigation
  'session.open',
  'session.fork',
  'session.rollback',
  'session.handoff',
  'session.spawn_new',
  'session.spawn_picker',
  // Local inventory + discovery (voice)
  'paths.list_recent',
  'machines.list',
  'servers.list',
  'review.engines.list',
  'agents.backends.list',
  'agents.models.list',
  // Session messaging
  'session.message.send',
  // Intent start actions (first-class)
  'review.start',
  'subagents.plan.start',
  'subagents.delegate.start',
  'voice_agent.start',
  // Execution runs control plane (RPC-backed)
  'execution.run.list',
  'execution.run.get',
  'execution.run.send',
  'execution.run.stop',
  'execution.run.action',
  // Session targeting + listing (voice)
  'session.target.primary.set',
  'session.target.tracked.set',
  'session.list',
  'session.activity.get',
  'session.messages.recent.get',
  // Session permissions (voice)
  'session.permission.respond',
  'session.user_action.answer',
  'session.mode.set',
  // Voice global controls
  'ui.voice_global.reset',
  'ui.voice_agent.teleport',

  // Daemon-local memory search (opt-in)
  'memory.search',
  'memory.get_window',
  'memory.ensure_up_to_date',

  // Prompt library / external prompt assets
  'prompt_doc.update',
  'prompt_bundle.update',
  'prompt_asset.export',
  'prompt_registry.install',

  // Action approvals (approval queue)
  'approval.request.create',
  'approval.request.decide',
] as const;

export const ActionIdSchema = z.enum(ACTION_IDS);
export type ActionId = z.infer<typeof ActionIdSchema>;

const LEGACY_ACTION_ID_ALIASES: Readonly<Record<string, ActionId>> = Object.freeze({
  'plan.start': 'subagents.plan.start',
  'delegate.start': 'subagents.delegate.start',
});

export function normalizeLegacyActionId(value: string): string {
  return LEGACY_ACTION_ID_ALIASES[value] ?? value;
}
