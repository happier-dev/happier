import type { ConversationCommandClassification } from './commands.js';

export const CONVERSATION_NON_ADMISSION_REASONS = [
  'connectionUnavailable',
  'staleAuthority',
  'endpointMismatch',
  'actorUnattributable',
  'actorNotAllowed',
  'integrationSelf',
  'botSenderDisabled',
  'messageTooOld',
  'messageTooLarge',
  'unsupportedContent',
  'unsupportedEdit',
  'notAddressed',
  'malformedCommand',
  'commandNotAuthorized',
  'targetUnavailable',
  'permissionCeilingUnavailable',
] as const;

export type ConversationNonAdmissionReason =
  (typeof CONVERSATION_NON_ADMISSION_REASONS)[number];

const SENDER_VISIBLE_REFUSALS = new Set<ConversationNonAdmissionReason>([
  'messageTooOld',
  'messageTooLarge',
  'unsupportedContent',
  'notAddressed',
  'malformedCommand',
]);

export function isConversationSenderFeedbackEligible(input: Readonly<{
  senderFeedback: 'off' | 'eligibleRefusals';
  actorPrincipalId: string | null;
  actorAllowed: boolean;
  reason: ConversationNonAdmissionReason;
}>): boolean {
  return input.senderFeedback === 'eligibleRefusals'
    && input.actorPrincipalId !== null
    && input.actorAllowed
    && SENDER_VISIBLE_REFUSALS.has(input.reason);
}

/**
 * The closed privacy-safe presentation vocabulary a terminal refusal projects
 * from its frozen nonAdmission fact. Availability refusals recover when the
 * named environment is reachable again; every other refusal is informational
 * history. `actionable` is not reason-derived: a row earns it only from its
 * own live retry or owner-exit affordance, never from this mapping.
 */
const RECOVERABLE_NON_ADMISSION_REASONS = new Set<ConversationNonAdmissionReason>([
  'connectionUnavailable',
  'targetUnavailable',
  'permissionCeilingUnavailable',
]);

export function projectConversationNonAdmissionPresentationCategory(
  reason: ConversationNonAdmissionReason,
): 'informational' | 'recoverable' {
  return RECOVERABLE_NON_ADMISSION_REASONS.has(reason) ? 'recoverable' : 'informational';
}

export type ConversationCommandPolicyInput = Readonly<{
  command: ConversationCommandClassification;
  actor: Readonly<{
    principalId: string | null;
    kind: 'human' | 'integration' | 'bot' | 'unknown';
    isIntegrationSelf: boolean;
  }>;
  contentProvenance: 'original' | 'forwarded' | 'viaBot';
  actorAllowed: boolean;
  allowBotSenders: boolean;
  targetKind: 'session' | 'automation';
  approvalCommandsEnabled: boolean;
  newSessionEnabled: boolean;
  senderFeedback: 'off' | 'eligibleRefusals';
}>;

export type ConversationCommandPolicyResult =
  | Readonly<{ kind: 'ordinaryText' }>
  | Extract<ConversationCommandClassification, Readonly<{
    kind: 'approve' | 'userActionAnswer' | 'newSession';
  }>>
  | Readonly<{
    kind: 'terminal';
    disposition: 'rejected';
    reason: ConversationNonAdmissionReason;
    senderFeedbackEligible: boolean;
  }>;

function terminal(
  input: ConversationCommandPolicyInput,
  reason: ConversationNonAdmissionReason,
  commandEligible = true,
): ConversationCommandPolicyResult {
  return {
    kind: 'terminal',
    disposition: 'rejected',
    reason,
    senderFeedbackEligible: commandEligible && isConversationSenderFeedbackEligible({
      senderFeedback: input.senderFeedback,
      actorPrincipalId: input.actor.principalId,
      actorAllowed: input.actorAllowed,
      reason,
    }),
  };
}

/** Applies authority/provenance to evidence from the one canonical text classifier. */
export function decideConversationCommandPolicy(
  input: ConversationCommandPolicyInput,
): ConversationCommandPolicyResult {
  if (input.actor.isIntegrationSelf) return terminal(input, 'integrationSelf');
  if (input.actor.principalId === null || input.actor.kind === 'unknown' || input.actor.kind === 'integration') {
    return terminal(input, 'actorUnattributable');
  }
  if (!input.actorAllowed) return terminal(input, 'actorNotAllowed');
  if (input.actor.kind === 'bot' && !input.allowBotSenders) return terminal(input, 'botSenderDisabled');

  const command = input.command;
  if (input.contentProvenance !== 'original'
    && (command.kind === 'pair'
      || command.kind === 'approve'
      || command.kind === 'userActionAnswer'
      || (command.kind === 'malformedCommand' && command.command !== 'newSession'))) {
    return { kind: 'ordinaryText' };
  }
  if (input.actor.kind === 'bot'
    && (command.kind === 'pair'
      || command.kind === 'approve'
      || command.kind === 'userActionAnswer'
      || (command.kind === 'malformedCommand' && command.command !== 'newSession'))) {
    return terminal(input, 'commandNotAuthorized');
  }
  if (command.kind === 'ordinaryText') return command;
  if (command.kind === 'malformedCommand') {
    const commandEligible = command.command === 'approve'
      ? input.approvalCommandsEnabled
      : command.command === 'answer'
        ? input.targetKind === 'session'
        : command.command === 'newSession'
          ? input.targetKind === 'session' && input.newSessionEnabled
          : false;
    return terminal(input, 'malformedCommand', commandEligible);
  }
  if (command.kind === 'pair') return terminal(input, 'commandNotAuthorized');
  if (command.kind === 'approve') {
    return input.approvalCommandsEnabled
      ? command
      : terminal(input, 'commandNotAuthorized');
  }
  if (command.kind === 'userActionAnswer') {
    // This authorizes the binding-scoped external mediator only. It does not
    // consult a permission scope because a user action creates no grant.
    return input.targetKind === 'session'
      ? command
      : terminal(input, 'commandNotAuthorized');
  }
  if (input.targetKind === 'automation') return { kind: 'ordinaryText' };
  if (!input.newSessionEnabled) return terminal(input, 'commandNotAuthorized');
  return command;
}

export function settleCompetingNewSessionCommand(input: Readonly<{
  ingressObligationId: string;
  initialPrompt?: string;
  createBusyResponse: boolean;
}>) {
  return {
    ingress: {
      phase: 'terminal',
      disposition: 'rotationBusy',
    },
    initialPromptDisposition: input.initialPrompt === undefined ? 'absent' : 'discarded',
    ...(input.createBusyResponse
      ? {
        controlResponse: {
          controlId: input.ingressObligationId,
          controlKind: 'newSession',
        },
      }
      : {}),
  } as const;
}
