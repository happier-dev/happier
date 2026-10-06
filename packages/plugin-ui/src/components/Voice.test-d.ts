import type { DictationButtonProps, SetupBlockGridProps, SetupStepsProps, StatusCellProps, TextFieldProps, VoiceMarkArtProps } from './index.public.js';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

const mark: VoiceMarkArtProps = { pose: 'ready', size: 24, theme: 'dark', light: [1, 0, 1], still: true };
const cell: StatusCellProps = { kind: 'thinking', label: 'Reviewing the draft', still: true };
const steps: SetupStepsProps = { steps: [{ key: 'one', title: 'Choose a service', state: 'current' }] };
const grid: SetupBlockGridProps = { testID: 'setup', items: [{ id: 'service', renderTile: () => null }] };
const dictation: DictationButtonProps = { onTranscription: (text) => text, presented: true };
const field: TextFieldProps = { label: 'Draft', value: '', onChange() {}, dictation };
void [mark, cell, steps, grid, dictation, field];

// @ts-expect-error Authors supply art, not a host attempt or its energy subscription.
const liveMark: VoiceMarkArtProps = { pose: 'ready', size: 24, voice: {} };
// @ts-expect-error Origin-neutral Dictation does not fabricate Session bindings.
const sessionDictation: DictationButtonProps = { onTranscription() {}, sessionId: 'session-1' };
void [liveMark, sessionDictation];

/** Public Actions lane contract: a plugin UI consumes the ordinary typed host dispatcher. */
async function requestVoice(host: PluginUiHostApi) {
  await host.executeAction('ui.voice_global.start', { target: { kind: 'global' }, expectedAttempt: null });
  await host.executeAction('ui.voice_global.brief.request', {});
}
void requestVoice;
