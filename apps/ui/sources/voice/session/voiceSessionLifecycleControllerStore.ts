import type { VoiceSessionLifecycleController } from './voiceSessionLifecycleController';

let controller: VoiceSessionLifecycleController | null = null;

export function getVoiceSessionLifecycleController(): VoiceSessionLifecycleController | null {
    return controller;
}

export function setVoiceSessionLifecycleController(next: VoiceSessionLifecycleController | null): void {
    controller = next;
}

export function resetVoiceSessionLifecycleControllerStoreForTests(): void {
    controller = null;
}
