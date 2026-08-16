import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';

type SessionRuntimeControlKey = keyof SessionRuntimeControls;

const SESSION_RUNTIME_CONTROL_KEYS = [
    'refreshGoal',
    'setGoal',
    'clearGoal',
    'listVendorPlugins',
    'listSkills',
    'startInlineReview',
    'invalidateConnectedServiceAuthTransports',
    'applyConnectedServiceAuthGeneration',
    'readConnectedServiceRuntimeIdentity',
    'enableUsageLimitWaitResume',
    'cancelUsageLimitWaitResume',
    'checkUsageLimitRecoveryNow',
    'clearTerminalComposer',
    'interruptPendingInputAndRun',
    'handleUserMessage',
    'wakePendingMaterialization',
    'isPendingMaterializationAvailable',
] as const satisfies readonly SessionRuntimeControlKey[];

export function copyCallableSessionRuntimeControls(
    target: Partial<SessionRuntimeControls>,
    controls: SessionRuntimeControls | Partial<SessionRuntimeControls> | null | undefined,
): void {
    if (!controls) return;
    const writableTarget = target as Record<SessionRuntimeControlKey, unknown>;
    const source = controls as Record<SessionRuntimeControlKey, unknown>;
    for (const key of SESSION_RUNTIME_CONTROL_KEYS) {
        const value = source[key];
        if (typeof value === 'function') writableTarget[key] = value;
    }
}

export function clearSessionRuntimeControls(target: Partial<SessionRuntimeControls>): void {
    const writableTarget = target as Record<SessionRuntimeControlKey, unknown>;
    for (const key of SESSION_RUNTIME_CONTROL_KEYS) {
        delete writableTarget[key];
    }
}

export function cloneCallableSessionRuntimeControls(
    controls: SessionRuntimeControls | Partial<SessionRuntimeControls> | null | undefined,
): Partial<SessionRuntimeControls> {
    const clone: Partial<SessionRuntimeControls> = {};
    copyCallableSessionRuntimeControls(clone, controls);
    return clone;
}
