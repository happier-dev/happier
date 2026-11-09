import type { CurrentUiContextHostCommand } from '@/components/appShell/currentUiContext/currentUiContextModel';
import { readCurrentUiContextActionReader } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** Lends the mounted owner's existing cancellation, never a second operation or installer. */
export function createVoiceModelCancellationCommand(input: Readonly<{
    packId: string;
    execution: 'device' | 'daemon';
    machineId: string | null;
    account: ServerAccountScopeLifetime | null;
    isCurrent(): boolean;
    cancel(): void;
}>): CurrentUiContextHostCommand | null {
    const account = input.account;
    if (!account) return null;
    const isCurrent = () => account.isCurrent() && input.isCurrent();
    return {
        kind: 'hostLocal',
        voiceModelCancellation: { packId: input.packId, execution: input.execution, machineId: input.machineId, account, isCurrent },
        invoke: ({ signal }) => {
            if (signal.aborted || !isCurrent()) return { ok: false, code: 'stale_surface' };
            input.cancel();
            return { ok: true };
        },
    };
}

type CapturedModelCancellation = Readonly<{
    target: NonNullable<CurrentUiContextHostCommand['voiceModelCancellation']>;
    cancel(signal?: AbortSignal): Promise<boolean>;
}>;

/** Capture before any awaited Settings read; a replacement cannot inherit an old Cancel request. */
export function captureVoiceModelCancellation(packId: string): CapturedModelCancellation | null {
    const reader = readCurrentUiContextActionReader({ surface: 'ui' });
    if (!reader) return null;
    let captured: CapturedModelCancellation | null = null;
    for (const descriptor of reader.readCurrentUiContext()?.commands ?? []) {
        const resolved = reader.resolveCurrentUiCommand(descriptor.id);
        if (!resolved) continue;
        const command = resolved.command;
        if (command.kind !== 'hostLocal' || command.voiceModelCancellation?.packId !== packId) continue;
        const target = command.voiceModelCancellation;
        const isCurrent = () => !resolved.retirementSignal.aborted && target.isCurrent()
            && reader.resolveCurrentUiCommand(descriptor.id)?.command === command;
        if (!isCurrent()) continue;
        // Two mounted controls can own the same pack. A pack-addressed Cancel
        // cannot choose one arbitrarily; its exact UI command remains usable.
        if (captured) return null;
        captured = { target, async cancel(signal?: AbortSignal) {
            if (!isCurrent()) return false;
            return (await command.invoke({ signal: signal ?? new AbortController().signal, context: { surface: 'ui' } })).ok;
        } };
    }
    return captured;
}
