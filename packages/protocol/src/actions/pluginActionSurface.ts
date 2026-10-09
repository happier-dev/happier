import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { ACTION_IDS, type ActionId } from './actionIds.js';

/** Host lifecycle/plumbing operations that are not author-facing Actions. */
export const INTERNAL_ACTION_REASONS = Object.freeze({
  'session.handoff.prepare_target': 'Private handoff lifecycle preparation phase; users invoke session.handoff instead.',
  'session.handoff.prepare_target.resume': 'Private handoff lifecycle retry phase; users invoke session.handoff instead.',
  'session.handoff.prepare_target_result.get': 'Private handoff coordination receipt read; session.handoff.status.get is the user projection.',
  'session.handoff.commit': 'Private handoff lifecycle commit phase; users invoke session.handoff instead.',
  'session.handoff.abort': 'Private handoff lifecycle abort phase; users invoke session.handoff instead.',
  'sessions.subagents.upsert': 'Host lifecycle projection maintenance; user operations use the planning/delegation Actions.',
  'sessions.subagents.updateStatus': 'Host lifecycle projection maintenance; user operations use the planning/delegation Actions.',
  'sessions.subagents.complete': 'Host lifecycle projection maintenance; user operations use the planning/delegation Actions.',
  'sessions.external.takeover': 'Released direct-session compatibility stub; current clients use sessions.external.takeover.start.',
  'plugin.webhook.delivery.movePending': 'Private webhook delivery plumbing owned by the webhook worker.',
  'devices.simulator.input.orientation': 'Stock scrcpy has no absolute-orientation producer; the simulator backing owner marks this Action statically unbacked.',
  'sessions.runner.activation.create': 'Creator-local package custody and endpoint consent make this an interactive Happier client operation.',
  'sessions.runner.activation.get': 'Creator-local Runner activation projection; external API exposure is intentionally withheld in v1.',
  'sessions.runner.activation.cancel': 'Creator-local cancellation preserves device custody and synchronized draft correspondence.',
  'session.presentation.apply': 'Ephemeral current-viewer command; trusted plugins use the public current-Session presentation service while Agents use this host-stamped Action.',
  'teams.invitations.accept.prepareApproval': 'Authenticated host preparation exchanges an invitation bearer for Account-bound deferred-approval custody; callers invoke teams.invitations.accept.',
} as const satisfies Readonly<Partial<Record<ActionId, string>>>);

export type InternalActionId = keyof typeof INTERNAL_ACTION_REASONS;

export const INTERNAL_ACTION_IDS = Object.freeze(
  Object.keys(INTERNAL_ACTION_REASONS) as InternalActionId[],
);

const INTERNAL_ACTION_ID_SET = new Set<ActionId>(INTERNAL_ACTION_IDS);

export function isInternalActionId(actionId: string): actionId is InternalActionId {
  return INTERNAL_ACTION_ID_SET.has(actionId as ActionId);
}

/** Interactive Account operations whose inputs or outputs contain human credentials. */
export const HUMAN_SECRET_API_EXCLUSION_REASONS = Object.freeze({
  'account.password.enroll': 'Password enrollment carries a prepared password credential and reauthentication proof material.',
  'account.password.change': 'Password change accepts current/new password or E2EE proof material.',
  'account.password.remove': 'Password removal accepts current-password or E2EE proof material.',
  'account.email.change.request': 'Sign-in email replacement starts an interactive identity-verification ceremony.',
  'account.apiTokens.create': 'Token creation returns a one-time bearer credential and may require trusted-device encryption material.',
  'account.apiTokens.list': 'Token inventory is an interactive Account credential-management operation; PAT-self wrapping retrieval remains on its dedicated bearer-only HTTP route.',
  'account.apiTokens.update': 'Token access updates are an interactive Account credential-management operation.',
  'account.security.terminalPresentUser.set': 'Terminal present-user policy is an interactive Account security-management operation.',
  'account.apiTokens.revoke': 'Token revocation is an interactive Account credential-management operation.',
  'account.apiTokens.revokeAll': 'Bulk token revocation is an interactive Account credential-management operation.',
} as const satisfies Readonly<Partial<Record<ActionId, string>>>);

export type HumanSecretApiExcludedActionId = keyof typeof HUMAN_SECRET_API_EXCLUSION_REASONS;

export const HUMAN_SECRET_API_EXCLUSION_ACTION_IDS = Object.freeze(
  Object.keys(HUMAN_SECRET_API_EXCLUSION_REASONS) as HumanSecretApiExcludedActionId[],
);

const HUMAN_SECRET_API_EXCLUSION_ACTION_ID_SET = new Set<ActionId>(
  HUMAN_SECRET_API_EXCLUSION_ACTION_IDS,
);

export function isHumanSecretApiExcludedActionId(
  actionId: string,
): actionId is HumanSecretApiExcludedActionId {
  return HUMAN_SECRET_API_EXCLUSION_ACTION_ID_SET.has(actionId as ActionId);
}

/**
 * The one policy owner for Actions omitted from trusted-plugin discovery and
 * invocation. It is intentionally independent of ActionSpec payload schemas so
 * foundational Plugin UI schemas can reference it without creating a module
 * initialization cycle through the full Action registry.
 */
export const PLUGIN_SURFACE_EXCLUSION_REASONS = Object.freeze({
  ...INTERNAL_ACTION_REASONS,
  'sessions.external.candidates.list': 'Machine/source-scoped discovery seam; authors use SessionsService.external.list, which delegates to this same candidate-query owner.',
  'sessions.external.candidate.delete': 'Host-synthesized destructive control over an Agent-owned session record; the External Sessions contribution deliberately owns discovery and transcripts only, never Agent session lifecycle.',
  'sessions.external.link.ensure': 'Machine/source-scoped linking seam; authors use SessionsService.external.attach, which delegates to this same idempotent link operation.',
  'sessions.external.follow': 'Ephemeral viewer lease seam; authors use SessionsService.external.followTranscript, which owns dynamic follow lifetime and cleanup.',
  'sessions.external.unfollow': 'Ephemeral viewer lease cleanup seam; authors close SessionsService.external.followTranscript rather than invoking a low-level lease Action.',
  'sessions.external.transcript.page': 'Machine/source-scoped transcript seam; authors use SessionsService.external.readTranscript.',
  'sessions.external.transcript.readAfter': 'Machine/source-scoped transcript seam; authors use SessionsService.external.readTranscript.',
  'sessions.external.takeover.start': 'Raw durable takeover Start; SessionsService.external.takeover privately delegates to it and is the documented author workflow.',
} as const satisfies Readonly<Partial<Record<ActionId, string>>>);

export type PluginSurfaceExcludedActionId = keyof typeof PLUGIN_SURFACE_EXCLUSION_REASONS;

export const PLUGIN_SURFACE_EXCLUSION_ACTION_IDS = Object.freeze(
  Object.keys(PLUGIN_SURFACE_EXCLUSION_REASONS) as PluginSurfaceExcludedActionId[],
);

const PLUGIN_SURFACE_EXCLUSION_ACTION_ID_SET = new Set<ActionId>(
  PLUGIN_SURFACE_EXCLUSION_ACTION_IDS,
);

export function isPluginSurfaceExcludedActionId(
  actionId: string,
): actionId is PluginSurfaceExcludedActionId {
  return PLUGIN_SURFACE_EXCLUSION_ACTION_ID_SET.has(actionId as ActionId);
}

export type PluginInvocableActionId = Exclude<
  ActionId,
  InternalActionId | PluginSurfaceExcludedActionId
>;

export const PLUGIN_INVOCABLE_ACTION_IDS = Object.freeze(
  ACTION_IDS.filter((actionId): actionId is PluginInvocableActionId => (
    !isPluginSurfaceExcludedActionId(actionId)
  )),
);

const PLUGIN_INVOCABLE_ACTION_ID_SET = new Set<string>(PLUGIN_INVOCABLE_ACTION_IDS);

export const PluginInvocableActionIdSchema = lazyZodSchema(() => z.custom<PluginInvocableActionId>(
  (actionId) => typeof actionId === 'string' && PLUGIN_INVOCABLE_ACTION_ID_SET.has(actionId),
  { message: 'Action is not available on the Plugin surface' },
));
