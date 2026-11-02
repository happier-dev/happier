import type { LocalVoiceAgentToolResultEntry } from '@/voice/tools/localVoiceEffectOutcomeCustody';
import { formatVoiceToolResultsFollowUp, VOICE_TOOL_RESULT_INSTRUCTIONS_PREFIX } from '@happier-dev/protocol/voice/toolResultsChannel';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveVoiceToolResultHumanSummary } from './resolveVoiceToolResultHumanSummary';
import { isVoiceToolResultBlockedByPrivacy, redactVoiceActionExecutionResultForProvider, redactVoiceToolResultForProvider, redactVoiceToolResultValue,
  type VoiceToolResultRedactionPrefs } from './redactVoiceToolResult';
import { resolveVoiceExecutionToolName, VOICE_ACTION_EXECUTE_TOOL_NAME } from '@/voice/tools/voiceActionExecution';

const PROVIDER_RESULT_ARGUMENT_OMITTED_TOOL_NAMES = new Set([
  getActionSpec('action.invoke').bindings?.voiceClientToolName,
  getActionSpec('ui.current_context.command.invoke').bindings?.voiceClientToolName,
].filter((value): value is string => typeof value === 'string' && value.length > 0));

/** Preserve the owner's selection, paging and completeness; only privacy projects its data. */
export function projectVoiceToolResultsForFollowUp(
  toolResults: ReadonlyArray<LocalVoiceAgentToolResultEntry>,
  prefs: VoiceToolResultRedactionPrefs,
): ReadonlyArray<LocalVoiceAgentToolResultEntry> {
  return toolResults.map(entry => {
    const resultOwner = resolveVoiceExecutionToolName(entry.t, entry.args);
    if (isVoiceToolResultBlockedByPrivacy(resultOwner, prefs)) {
      return { t: entry.t, args: null, result: { ok: false, errorCode: 'privacy_disabled', errorMessage: 'privacy_disabled' } };
    }
    const summary = resolveVoiceToolResultHumanSummary({ toolName: entry.t, toolInput: entry.args,
      toolResult: entry.result, shareFilePaths: prefs.shareFilePaths, shareSessionSummary: prefs.shareSessionSummary });
    const result = entry.t === VOICE_ACTION_EXECUTE_TOOL_NAME
      ? redactVoiceActionExecutionResultForProvider(resultOwner, entry.result, prefs)
      : redactVoiceToolResultForProvider(resultOwner, entry.result, prefs);
    return {
      t: entry.t,
      // The provider already owns this call. Repeating input would disclose Action
      // operands or an ephemeral current-UI command id in the result channel.
      args: PROVIDER_RESULT_ARGUMENT_OMITTED_TOOL_NAMES.has(entry.t) ? null : redactVoiceToolResultValue(entry.args, prefs),
      result: !summary ? result : result && typeof result === 'object' && !Array.isArray(result)
        ? { ...result, summary } : { summary, value: result },
    };
  });
}

export function buildToolResultsFollowUpPrompt(
  toolResults: ReadonlyArray<LocalVoiceAgentToolResultEntry>,
  prefs: VoiceToolResultRedactionPrefs,
): string {
  const hasErrors = toolResults.some(({ result }) => result !== null && typeof result === 'object'
    && (('ok' in result && result.ok === false) || ('errorCode' in result && typeof result.errorCode === 'string')));
  const instruction = hasErrors
    ? VOICE_TOOL_RESULT_INSTRUCTIONS_PREFIX + ' At least one action failed. Do not claim success, do not repeat a requested success token, and explain the failure plainly.'
    : VOICE_TOOL_RESULT_INSTRUCTIONS_PREFIX + ' Report the actual outcome, including pending, unknown or approval-required outcomes. Confirm completion only when the result establishes it.';
  return formatVoiceToolResultsFollowUp({ toolResults: projectVoiceToolResultsForFollowUp(toolResults, prefs) }) + '\n' + instruction;
}
