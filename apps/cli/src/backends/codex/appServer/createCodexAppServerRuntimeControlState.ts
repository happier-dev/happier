import type { PermissionMode } from '@/api/types';
import { delay } from '@/utils/time';

import {
    resolveCodexAppServerPolicyForPermissionMode,
    type CodexAppServerPolicy,
} from '../utils/permissionModePolicy';

type PendingTurnRef = Readonly<{
    turnId: string | null;
}>;

export function createCodexAppServerRuntimeControlState(params: Readonly<{
    directory: string;
    onThinkingChange: (thinking: boolean) => void;
    getPermissionMode?: (() => PermissionMode) | null;
    permissionMode?: PermissionMode;
    getPendingTurn: () => PendingTurnRef | null;
    getLatestPendingTurnId: () => string | null;
}>): Readonly<{
    getCurrentPermissionMode: () => PermissionMode;
    // Returns null when Happier resolves to 'default' so callers OMIT policy fields from
    // app-server RPC requests, letting Codex honor ~/.codex/config.toml (top-level
    // approval_policy/sandbox_mode or a `profile = "..."` selection). Non-default modes still
    // produce a concrete policy that overrides config.toml as before.
    resolveCurrentPolicy: () => CodexAppServerPolicy | null;
    setThinking: (thinking: boolean) => void;
    waitForActiveTurnId: () => Promise<string | null>;
}> {
    let thinking = false;

    const getCurrentPermissionMode = (): PermissionMode =>
        params.getPermissionMode?.() ?? params.permissionMode ?? 'default';

    const resolveCurrentPolicy = (): CodexAppServerPolicy | null => {
        const mode = getCurrentPermissionMode();
        if (mode === 'default') return null;
        return resolveCodexAppServerPolicyForPermissionMode(mode, {
            directory: params.directory,
        });
    };

    const setThinking = (nextThinking: boolean): void => {
        if (thinking === nextThinking) return;
        thinking = nextThinking;
        params.onThinkingChange(nextThinking);
    };

    // `turn/steer` and `turn/interrupt` require a turn id, but we may not have observed it yet
    // when the user acts immediately after sending a message.
    const turnIdWaitTimeoutMs = 1_000;
    const turnIdWaitPollMs = 20;
    const waitForActiveTurnId = async (): Promise<string | null> => {
        let turnId = params.getPendingTurn()?.turnId ?? params.getLatestPendingTurnId();
        if (turnId) return turnId;
        const waitStartedAt = Date.now();
        while (!turnId && Date.now() - waitStartedAt < turnIdWaitTimeoutMs) {
            await delay(turnIdWaitPollMs);
            turnId = params.getPendingTurn()?.turnId ?? params.getLatestPendingTurnId();
        }
        return turnId ?? null;
    };

    return {
        getCurrentPermissionMode,
        resolveCurrentPolicy,
        setThinking,
        waitForActiveTurnId,
    };
}
