import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

// A host descriptor is not content demand. Keep each real renderer behind its own
// import, and suspend only its content so the surrounding collection stays present.
function lazyPresenter<Props extends object>(load: () => Promise<{ default: React.ComponentType<Props> }>) {
    const Content = retryableLazy(load);
    return function Presenter(props: Props) {
        return <React.Suspense fallback={null}><Content {...props} /></React.Suspense>;
    };
}

export const PluginUiMarkdown = lazyPresenter(async () => ({ default: (await import('./PluginUiMarkdown')).PluginUiMarkdown }));
export const PluginUiPrivateDiffViewer = lazyPresenter(async () => ({ default: (await import('./PluginUiPrivateDiffViewer')).PluginUiPrivateDiffViewer }));
export const ProseDiffViewer = lazyPresenter(async () => ({ default: (await import('@/components/ui/code/diff/prose/ProseDiffViewer')).ProseDiffViewer }));
export const CodeBlockView = lazyPresenter(async () => ({ default: (await import('@/components/ui/code/blocks/CodeBlockView')).CodeBlockView }));
export const QRCode: React.ComponentType<React.ComponentProps<typeof import('@/components/qr/QRCode').QRCode>> = lazyPresenter(async () => ({ default: (await import('@/components/qr/QRCode')).QRCode }));
export const PluginVoicePresence = lazyPresenter(async () => ({ default: (await import('./PluginVoicePresence')).PluginVoicePresence }));
export const PluginVoiceMark = lazyPresenter(async () => ({ default: (await import('./PluginVoicePresence')).PluginVoiceMark }));
export const PluginVoiceStatusLine = lazyPresenter(async () => ({ default: (await import('./PluginVoicePresence')).PluginVoiceStatusLine }));
export const PluginVoiceTransport = lazyPresenter(async () => ({ default: (await import('./PluginVoicePresence')).PluginVoiceTransport }));
export const PluginDictationButton = lazyPresenter(async () => ({ default: (await import('./PluginDictationButton')).PluginDictationButton }));
export const VoiceMarkArt = lazyPresenter(async () => ({ default: (await import('@/components/voice/presence/VoiceMark')).VoiceMarkArt }));
export const VoiceStatusCell = lazyPresenter(async () => ({ default: (await import('@/components/voice/presence/VoiceStatusCell')).VoiceStatusCell }));
export const SceneArt = lazyPresenter(async () => ({ default: (await import('@/components/ui/surfaces/SceneArt')).SceneArt }));
export const SessionBotFace = lazyPresenter(async () => ({ default: (await import('@/components/sessions/bots/face/SessionBotFace')).SessionBotFace }));
export const ExecutableParticipantPickerPresentation = lazyPresenter(async () => ({ default: (await import('@/components/sessions/authoring/ExecutableParticipantPickerPresentation')).ExecutableParticipantPickerPresentation }));
