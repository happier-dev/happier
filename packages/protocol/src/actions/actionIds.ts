import { z } from 'zod';

// B8 closure note:
// Action ids remain protocol-owned and closed in this wave.
// Plugin/runtime unification must not imply plugin-defined action-id authoring parity yet.
export const ACTION_ID_FAMILIES_V1 = Object.freeze({
  discovery: [
    'action.spec.search',
    'action.spec.get',
    'action.options.resolve',
  ],
  session_lifecycle: [
    'session.open',
    'session.fork',
    'session.rollback',
    'session.handoff',
    'session.spawn_new',
    'session.spawn_picker',
  ],
  inventory: [
    'paths.list_recent',
    'machines.list',
    'servers.list',
    'review.engines.list',
    'agents.backends.list',
    'agents.models.list',
  ],
  messaging: [
    'session.message.send',
  ],
  session_control: [
    'session.stop',
    'session.title.set',
    'session.model.set',
    'session.permission_mode.set',
    'session.archive',
    'session.unarchive',
    'session.status.get',
    'session.history.get',
    'session.wait.idle',
  ],
  intent_start: [
    'review.start',
    'subagents.plan.start',
    'subagents.delegate.start',
    'voice_agent.start',
  ],
  execution_run_control: [
    'execution.run.start',
    'execution.run.list',
    'execution.run.get',
    'execution.run.send',
    'execution.run.stop',
    'execution.run.action',
    'execution.run.wait',
  ],
  session_targeting: [
    'session.target.primary.set',
    'session.target.tracked.set',
    'session.list',
    'session.activity.get',
    'session.messages.recent.get',
  ],
  session_permissions: [
    'session.permission.respond',
    'session.user_action.answer',
    'session.mode.set',
  ],
  voice_controls: [
    'ui.voice_global.reset',
    'ui.voice_agent.teleport',
  ],
  memory: [
    'memory.search',
    'memory.get_window',
    'memory.ensure_up_to_date',
  ],
  prompt_library: [
    'prompt_doc.update',
    'prompt_bundle.update',
    'prompt_asset.export',
    'prompt_registry.install',
  ],
  approvals: [
    'approval.request.create',
    'approval.request.decide',
  ],
} as const);

export const ACTION_IDS = [
  ...ACTION_ID_FAMILIES_V1.discovery,
  ...ACTION_ID_FAMILIES_V1.session_lifecycle,
  ...ACTION_ID_FAMILIES_V1.inventory,
  ...ACTION_ID_FAMILIES_V1.messaging,
  ...ACTION_ID_FAMILIES_V1.session_control,
  ...ACTION_ID_FAMILIES_V1.intent_start,
  ...ACTION_ID_FAMILIES_V1.execution_run_control,
  ...ACTION_ID_FAMILIES_V1.session_targeting,
  ...ACTION_ID_FAMILIES_V1.session_permissions,
  ...ACTION_ID_FAMILIES_V1.voice_controls,
  ...ACTION_ID_FAMILIES_V1.memory,
  ...ACTION_ID_FAMILIES_V1.prompt_library,
  ...ACTION_ID_FAMILIES_V1.approvals,
] as const;

export const ActionIdSchema = z.enum(ACTION_IDS);
export type ActionId = z.infer<typeof ActionIdSchema>;
export type ActionIdFamilyV1 = keyof typeof ACTION_ID_FAMILIES_V1;

const LEGACY_ACTION_ID_ALIASES: Readonly<Record<string, ActionId>> = Object.freeze({
  'plan.start': 'subagents.plan.start',
  'delegate.start': 'subagents.delegate.start',
});

export function normalizeLegacyActionId(value: string): string {
  return LEGACY_ACTION_ID_ALIASES[value] ?? value;
}
