import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CodexBackendMode } from '@happier-dev/agents';

import { applyTerminalRemoteLaunchGating } from '@/agent/runtimeSwitching/launchGating';
import { isExperimentalCodexAcpEnabled } from '@/backends/codex/experiments';

import { createCodexTerminalRuntimeSupportResolver } from '../../terminalRuntime/supportResolver';
import {
    formatCodexTerminalRuntimeLaunchFallbackMessage,
    type CodexTerminalRuntimeBackend,
} from '../../terminalRuntime/terminalRuntimeSupport';
import { resolveCodexBackendModeForRun } from '../../utils/resolveCodexBackendModeForRun';
import { resolveCodexStartupRuntimeMode } from '../../utils/resolveCodexStartupRuntimeMode';
import {
    type CodexRuntimeMode,
} from '../session/types';

export type CodexTerminalRuntimeStartupState = Readonly<{
    codexBackendMode: CodexBackendMode;
    codexAcpFallbackToMcpMessage: string | null;
    experimentalCodexAcpEnabled: boolean;
    hasTtyForTerminalRuntime: boolean;
    initialCodexAcpFallbackToMcpMessage: string | null;
    fallbackToRemoteMessage: string | null;
    runtimeMode: CodexRuntimeMode;
    resolveTerminalRuntimeSupport: ReturnType<typeof createCodexTerminalRuntimeSupportResolver>;
    terminalRuntimeBackend: CodexTerminalRuntimeBackend | null;
    terminalRuntimeEnabled: boolean;
    terminalRuntimeState: {
        experimentalCodexAcpEnabled: boolean;
        terminalRuntimeBackend: CodexTerminalRuntimeBackend | null;
    };
}>;

export async function resolveCodexTerminalRuntimeStartupState(params: Readonly<{
    codexBackendMode?: CodexBackendMode;
    explicitStartingRuntimeMode?: CodexRuntimeMode;
    hasTtyForTerminalRuntime: boolean;
    resumeIdFromArgs: string | null;
    startedByForTerminalRuntime: 'cli' | 'daemon';
}>): Promise<CodexTerminalRuntimeStartupState> {
    const codexBackendMode = resolveCodexBackendModeForRun({
        codexBackendMode: params.codexBackendMode,
        experimentalCodexAcpEnabledByDefault: isExperimentalCodexAcpEnabled(),
    });
    const experimentalCodexAcpEnabled = codexBackendMode === 'acp';
    const terminalRuntimeBackend: CodexTerminalRuntimeBackend | null =
        codexBackendMode === 'acp' || codexBackendMode === 'appServer' ? codexBackendMode : null;
    const terminalRuntimeEnabled = terminalRuntimeBackend !== null;

    const terminalRuntimeState: {
        experimentalCodexAcpEnabled: boolean;
        terminalRuntimeBackend: CodexTerminalRuntimeBackend | null;
    } = {
        experimentalCodexAcpEnabled,
        terminalRuntimeBackend,
    };

    const resolveTerminalRuntimeSupport = createCodexTerminalRuntimeSupportResolver({
        startedBy: params.startedByForTerminalRuntime,
        experimentalCodexAcpEnabled: () => terminalRuntimeState.experimentalCodexAcpEnabled,
        terminalRuntimeBackend: () => terminalRuntimeState.terminalRuntimeBackend,
        hasTtyForTerminal: params.hasTtyForTerminalRuntime,
    });

    let runtimeMode = resolveCodexStartupRuntimeMode({
        explicitRuntimeMode: params.explicitStartingRuntimeMode,
        startedBy: params.startedByForTerminalRuntime,
        hasTtyForTerminal: params.hasTtyForTerminalRuntime,
        terminalRuntimeEnabled,
    });

    let fallbackToRemoteMessage: string | null = null;
    let codexAcpFallbackToMcpMessage: string | null = (() => {
        const raw = typeof process.env.HAPPIER_CODEX_ACP_FALLBACK_TO_MCP_MESSAGE === 'string'
            ? process.env.HAPPIER_CODEX_ACP_FALLBACK_TO_MCP_MESSAGE.trim()
            : '';
        return raw ? raw : null;
    })();

    if (!codexAcpFallbackToMcpMessage && experimentalCodexAcpEnabled && !params.resumeIdFromArgs) {
        const envOverride = typeof process.env.HAPPIER_CODEX_ACP_BIN === 'string' ? process.env.HAPPIER_CODEX_ACP_BIN.trim() : '';
        const shouldTreatOverrideAsPath =
            envOverride.startsWith('.') || envOverride.startsWith('/') || envOverride.includes('\\');
        if (envOverride && shouldTreatOverrideAsPath) {
            const resolved = resolve(process.cwd(), envOverride);
            if (!existsSync(resolved)) {
                const reason = `Codex ACP is enabled but HAPPIER_CODEX_ACP_BIN does not exist: ${resolved}`;
                codexAcpFallbackToMcpMessage =
                    codexAcpFallbackToMcpMessage ??
                    `Codex ACP could not start (${reason}). Falling back to MCP for this new session.`;
            }
        }
    }

    const initialCodexAcpFallbackToMcpMessage = codexAcpFallbackToMcpMessage;

    if (runtimeMode === 'terminal') {
        // Terminal-runtime gating must run before any heavy initialization so we fail fast to remote when needed.
        const support = await resolveTerminalRuntimeSupport({ includeAcpProbe: false });
        const gated = applyTerminalRemoteLaunchGating({ startingMode: 'local', support });
        if (gated.mode === 'remote' && gated.fallback) {
            fallbackToRemoteMessage = formatCodexTerminalRuntimeLaunchFallbackMessage(gated.fallback.reason);
            runtimeMode = 'remote';
        }
    }

    return {
        codexBackendMode,
        codexAcpFallbackToMcpMessage,
        experimentalCodexAcpEnabled,
        hasTtyForTerminalRuntime: params.hasTtyForTerminalRuntime,
        initialCodexAcpFallbackToMcpMessage,
        fallbackToRemoteMessage,
        runtimeMode,
        resolveTerminalRuntimeSupport,
        terminalRuntimeBackend,
        terminalRuntimeEnabled,
        terminalRuntimeState,
    };
}
