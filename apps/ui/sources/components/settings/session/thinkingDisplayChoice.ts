/**
 * How a session shows the agent's thinking: one person-facing choice stored across two Account
 * fields (`sessionThinkingDisplayMode` and, for inline, `sessionThinkingInlinePresentation`).
 * Settings → Transcript, Personalize and the `transcript.displayMode` Action all read and write it
 * here, so the four options can never be interpreted two ways.
 */
export { THINKING_DISPLAY_CHOICES, isThinkingDisplayChoice, resolveThinkingDisplayChoice, resolveThinkingDisplayChoiceDelta } from '@happier-dev/protocol/actions/settings/accountSettingChoiceReducers';
export type { ThinkingDisplayChoice, ThinkingDisplaySettings, ThinkingDisplayChoiceDelta } from '@happier-dev/protocol/actions/settings/accountSettingChoiceReducers';

export { thinkingDisplayStorageBinding } from '@happier-dev/protocol/actions/settings/accountSettingBindings';
