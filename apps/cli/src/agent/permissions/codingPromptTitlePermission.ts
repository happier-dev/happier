import { resolveEffectiveCodingPromptBehaviorV1 } from '@happier-dev/protocol/prompts/effectiveCodingPromptBehaviorV1';
import { isChangeTitleToolLikeName } from '@happier-dev/protocol/tools/v2/aliases';
import { hasSessionTitleInMetadata } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { ActionExecutorDeps, CodingPromptBehaviorV1 } from '@happier-dev/protocol';

function readActionId(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const raw = (input as Record<string, unknown>).actionId;
  return typeof raw === 'string' ? raw.trim() : '';
}

function isTitleActionExecute(toolName: string, input: unknown): boolean {
  const lower = toolName.toLowerCase();
  return lower.includes('action_execute') && readActionId(input) === 'session.title.set';
}

export function isAgentSessionTitleToolCall(toolName: string, input: unknown): boolean {
  return isChangeTitleToolLikeName(toolName)
    || isTitleActionExecute(toolName, input);
}

/**
 * Tool admission for agent-initiated session-title calls.
 *
 * Reads the SAME resolved `codingPromptBehavior` fact the prompt composer reads
 * (`resolveEffectiveCodingPromptBehaviorV1`: Account default, then the selected
 * Launch Profile's sparse override). Deciding from the Account value alone made
 * this a second decision-maker: a profile that re-enabled title updates was told
 * to call `change_title` by the system prompt while this gate denied every call.
 */
export function shouldDenyAgentSessionTitleToolCall(params: Readonly<{
  settings: unknown;
  profileId?: string | null | undefined;
  codingPromptBehavior?: CodingPromptBehaviorV1 | null;
  toolName: string;
  input: unknown;
}>): boolean {
  if (!isAgentSessionTitleToolCall(params.toolName, params.input)) return false;
  return params.codingPromptBehavior === null || (params.codingPromptBehavior ?? resolveEffectiveCodingPromptBehaviorV1({
    settings: params.settings,
    profileId: params.profileId ?? null,
  })).sessionTitleUpdates === 'disabled';
}

export class SessionAgentTitleUpdateDenied extends Error {
  readonly code = 'session_title_updates_disabled';
  readonly retryable = false;

  constructor() {
    super('session_title_updates_disabled');
  }
}

type SessionStateFieldWrite = Parameters<NonNullable<ActionExecutorDeps['sessionStateFieldSet']>>[0];

export function createSessionAgentTitleWriteGuard(
  write: SessionStateFieldWrite,
  readSettings: () => unknown,
): ((metadata: unknown) => void) | undefined {
  if (write.fieldId !== 'display.title'
    || write.context.surface !== 'agent'
    || write.context.actionCaller?.kind !== 'session') return undefined;

  return (metadata) => {
    const profileId = metadata && typeof metadata === 'object' && 'profileId' in metadata
      && typeof metadata.profileId === 'string' ? metadata.profileId : null;
    const { sessionTitleUpdates } = resolveEffectiveCodingPromptBehaviorV1({
      settings: readSettings(),
      profileId,
    });
    if (sessionTitleUpdates === 'disabled'
      || (sessionTitleUpdates === 'initial' && hasSessionTitleInMetadata(metadata))) {
      throw new SessionAgentTitleUpdateDenied();
    }
  };
}
