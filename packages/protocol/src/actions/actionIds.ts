import { z } from 'zod';

export const ACTION_IDS = [
  // Session lifecycle / navigation
  'session.open',
  'session.spawn_new',
  'session.spawn_picker',
  // Local inventory + discovery (voice)
  'workspaces.list_recent',
  'paths.list_recent',
  'machines.list',
  'servers.list',
  'agents.backends.list',
  'agents.models.list',
  // Session messaging
  'session.message.send',
  // Intent start actions (first-class)
  'review.start',
  'plan.start',
  'delegate.start',
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
  // Voice global controls
  'ui.voice_global.reset',

  // Daemon-local memory search (opt-in)
  'memory.search',
  'memory.get_window',
  'memory.ensure_up_to_date',
] as const;

export const ActionIdSchema = z.enum(ACTION_IDS);
export type ActionId = z.infer<typeof ActionIdSchema>;
