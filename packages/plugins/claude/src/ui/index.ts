import { CLAUDE_UI_DESCRIPTOR } from './descriptor.js';

export { CLAUDE_UI_DESCRIPTOR };
export { CLAUDE_AGENT_SETTINGS_DESCRIPTOR } from './settings/descriptor.js';
export { resolveClaudeBrowseSourceOptions } from './externalSessions/browseSources.js';
export { buildClaudeReasoningEffortMessageMetaOverrides } from './messageMeta/reasoningEffort.js';
export { buildClaudeSessionHandoffProviderPatch } from './sessionHandoff.js';
export { CLAUDE_UI_BEHAVIOR_OVERRIDE, createClaudeUiBehaviorOverride } from './uiBehavior.js';
export { resolveClaudeUnifiedDialogQuestionPresentation } from './workflow/resolveUnifiedDialogQuestionPresentation.js';
export type {
  ClaudeBrowseSourceTranslationKey,
  ClaudeExternalSessionBrowseSourceOption,
} from './externalSessions/browseSources.js';
export type { ClaudeSessionHandoffProviderPatch } from './sessionHandoff.js';
export type {
  ClaudeUiBehaviorDependencies,
  ClaudeUiBehaviorOverride,
} from './uiBehavior.js';
export type { ClaudeUnifiedDialogQuestionInput } from './workflow/resolveUnifiedDialogQuestionPresentation.js';

export const ui = Object.freeze({
  descriptor: CLAUDE_UI_DESCRIPTOR,
});
