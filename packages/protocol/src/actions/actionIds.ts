import { z } from 'zod';

export const ACTION_IDS = [
  // Session lifecycle / navigation
  'session.open',
  'session.spawn_new',
  // Session messaging
  'session.message.send',
  // Execution runs control plane (RPC-backed)
  'execution.run.start',
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
] as const;

export const ActionIdSchema = z.enum(ACTION_IDS);
export type ActionId = z.infer<typeof ActionIdSchema>;
