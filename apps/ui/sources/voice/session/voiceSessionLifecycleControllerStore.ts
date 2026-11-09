import type { VoiceSessionLifecycleController } from './voiceSessionLifecycleController';

let controller: VoiceSessionLifecycleController | null = null;
let readyController: VoiceSessionLifecycleController | null = null;
let requestedRuntime: Readonly<{
    providerId: string;
    resolve: (controller: VoiceSessionLifecycleController | null) => void;
    reject: (error: unknown) => void;
}> | null = null;

/** The first Start waits for the existing mounted owner, without a second loader. */
export function requestVoiceSessionRuntime(providerId: string, signal: AbortSignal): Readonly<{
    ready: Promise<VoiceSessionLifecycleController | null>;
    dispose: () => void;
}> {
    let resolve!: (controller: VoiceSessionLifecycleController | null) => void;
    let reject!: (error: unknown) => void;
    const ready = new Promise<VoiceSessionLifecycleController | null>((accept, refuse) => {
        resolve = accept;
        reject = refuse;
    });
    const request = { providerId, resolve, reject };
    requestedRuntime?.resolve(null);
    requestedRuntime = request;
    if (readyController === controller && controller) resolve(controller);
    const dispose = () => {
        if (requestedRuntime === request) requestedRuntime = null;
        signal.removeEventListener('abort', dispose);
        resolve(null);
    };
    signal.addEventListener('abort', dispose, { once: true });
    if (signal.aborted) dispose();
    return { ready, dispose };
}

export function getRequestedVoiceSessionProviderId(): string | null {
    return requestedRuntime?.providerId ?? null;
}

export function acknowledgeVoiceSessionRuntimeReady(ready: boolean): void {
    readyController = ready ? controller : null;
    if (readyController) requestedRuntime?.resolve(readyController);
}

export function rejectVoiceSessionRuntimeRequest(error: unknown): void {
    requestedRuntime?.reject(error);
}

export function getVoiceSessionLifecycleController(): VoiceSessionLifecycleController | null {
    return controller;
}

export function setVoiceSessionLifecycleController(next: VoiceSessionLifecycleController | null): void {
    if (controller !== next) readyController = null;
    controller = next;
}

export function resetVoiceSessionLifecycleControllerStoreForTests(): void {
    requestedRuntime?.resolve(null);
    requestedRuntime = null;
    readyController = null;
    controller = null;
}
