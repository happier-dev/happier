import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

// Keep the substantial Markdown and diff graphs behind content demand.
// The smaller presenters share dependencies and render synchronously.
function lazyPresenter<Props extends object>(load: () => Promise<{ default: React.ComponentType<Props> }>) {
    const Content = retryableLazy(load);
    return function Presenter(props: Props) {
        return <React.Suspense fallback={null}><Content {...props} /></React.Suspense>;
    };
}

export const PluginUiMarkdown = lazyPresenter(async () => ({ default: (await import('./PluginUiMarkdown')).PluginUiMarkdown }));
export const PluginUiPrivateDiffViewer = lazyPresenter(async () => ({ default: (await import('./PluginUiPrivateDiffViewer')).PluginUiPrivateDiffViewer }));
export const ProseDiffViewer = lazyPresenter(async () => ({ default: (await import('@/components/ui/code/diff/prose/ProseDiffViewer')).ProseDiffViewer }));

export { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
export { QRCode } from '@/components/qr/QRCode';
export { PluginVoicePresence, PluginVoiceMark, PluginVoiceStatusLine, PluginVoiceTransport } from './PluginVoicePresence';
export { PluginDictationButton } from './PluginDictationButton';
export { VoiceMarkArt } from '@/components/voice/presence/VoiceMark';
export { VoiceStatusCell } from '@/components/voice/presence/VoiceStatusCell';
export { SceneArt } from '@/components/ui/surfaces/SceneArt';
export { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
export { ExecutableParticipantPickerPresentation } from '@/components/sessions/authoring/ExecutableParticipantPickerPresentation';
