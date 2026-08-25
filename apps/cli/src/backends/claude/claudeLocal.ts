import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { logger } from "@/ui/logger";
import { attachProcessSignalForwardingToChild } from '@/agent/runtime/signalForwarding';
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { claudeFindLastSession } from "./utils/claudeFindLastSession";
import { getProjectPath } from "./utils/path";
import { getClaudeSystemPrompt } from "./utils/systemPrompt";
import { restoreStdinBestEffort } from "@/ui/ink/restoreStdinBestEffort";
import { isClaudeCliJavaScriptFile, resolveClaudeCliPath } from "./utils/resolveClaudeCliPath";
import { stripNestedSessionDetectionEnv } from "@/utils/processEnv/stripNestedSessionDetectionEnv";
import { ensureClaudeJsRuntimeExecutable } from "./utils/ensureClaudeJsRuntimeExecutable";
import { resolveClaudeConfigDirOverride } from "./utils/resolveClaudeConfigDirOverride";
import { resolveClaudeConfigDirEnvOverlay } from "./utils/resolveClaudeConfigDirEnvOverlay";
import { buildMissingJavaScriptRuntimeMessage } from "@/runtime/js/buildMissingJavaScriptRuntimeMessage";
import { isEmbeddedBunBundlePath } from "@/runtime/js/isEmbeddedBunBundlePath";
import { resolveWindowsCommandInvocation, type CommandInvocation } from '@happier-dev/cli-common/process';
import { resolveCliRuntimeAssetPath } from '@/runtime/assets/resolveCliRuntimeAssetPath';
import { HAPPIER_BASE_SYSTEM_PROMPT_V1 } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { isolateClaudeRuntimeAuthEnv } from './spawn/isolateClaudeRuntimeAuthEnv';
import { logClaudeRuntimeAuthEnvDiagnostic } from './spawn/logClaudeRuntimeAuthEnvDiagnostic';
import { HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR } from '@/daemon/spawn/spawnExplicitEnvKeysMarker';
import { claudeCliFlagCanConsumeNextArg } from './cli/flagArity';
import {
    buildClaudePermissionModeLaunchSettings,
    resolveClaudeLaunchSettingsOverlayArg,
} from './utils/resolveClaudeLaunchSettingsOverlay';
import {
    materializeClaudeMcpConfigArgsForSpawn,
    type MaterializedClaudeMcpConfigArgs,
} from './utils/materializeClaudeMcpConfigArgsForSpawn';

/**
 * Error thrown when the Claude process exits with a non-zero exit code.
 */
export class ExitCodeError extends Error {
    public readonly exitCode: number;

    constructor(exitCode: number) {
        super(`Process exited with code: ${exitCode}`);
        this.name = 'ExitCodeError';
        this.exitCode = exitCode;
    }
}


// Get Claude CLI path from project root
export const claudeCliPath = resolveCliRuntimeAssetPath('scripts', 'claude_local_launcher.cjs');

const CLAUDE_LOCAL_FETCH_IDLE_CLEAR_DELAY_MS = 500;
const CLAUDE_LOCAL_UNKNOWN_FETCH_ID = '__happier_unknown_claude_fetch__';
const REDACTED_MCP_CONFIG_LOG_VALUE = '[redacted-mcp-config]';

function redactClaudeArgsForLog(args: readonly string[]): string[] {
    const redacted: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? '';

        if (arg === '--mcp-config') {
            redacted.push(arg);
            if (i + 1 < args.length) {
                redacted.push(REDACTED_MCP_CONFIG_LOG_VALUE);
                i += 1;
            }
            continue;
        }

        if (arg.startsWith('--mcp-config=')) {
            redacted.push(`--mcp-config=${REDACTED_MCP_CONFIG_LOG_VALUE}`);
            continue;
        }

        redacted.push(arg);
    }

    return redacted;
}

export async function claudeLocal(opts: {
    abort: AbortSignal,
    sessionId: string | null,
    path: string,
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onLifecycleGapDetected?: ((event: Readonly<{
        source: 'fd3_fetch_fallback',
        signal: 'fetch_start' | 'fetch_idle_clear',
        activeFetchCount: number,
    }>) => void) | undefined,
    claudeArgs?: string[],
    /** Base environment for the managed Claude subprocess. Defaults to the current process environment. */
    processEnv?: NodeJS.ProcessEnv,
    /** Optional env overrides to apply to the spawned Claude Code subprocess. */
    envOverlay?: Record<string, string>,
    /** Optional MCP config JSON to inject into the Claude Code CLI invocation (e.g. Happier MCP). */
    happierMcpConfigJson?: string,
    /** Path to temporary settings file with non-hook config (optional - for session tracking) */
    hookSettingsPath?: string
    /**
     * Optional path to a Happier-generated plugin directory containing `hooks/hooks.json`.
     * When set, Claude is launched with `--plugin-dir <path>` so SessionStart and
     * PermissionRequest hooks register via the additive plugin channel. The `--settings`
     * slot is non-composable and can be claimed by a PATH-resident wrapper (e.g. cmux),
     * silently dropping hooks; --plugin-dir sidesteps that.
     */
    hookPluginDir?: string | null
    /** Effective session prompt text for new sessions; falls back to Claude-specific provider behavior blocks. */
    systemPromptText?: string | null,
}) {

    const processEnv = opts.processEnv ?? process.env;
    const claudeConfigDir = resolveClaudeConfigDirOverride(processEnv);

    // Ensure project directory exists
    const projectDir = getProjectPath(opts.path, claudeConfigDir);
    mkdirSync(projectDir, { recursive: true });

    // Check if claudeArgs contains --continue or --resume (user passed these flags)
    const hasContinueFlag = opts.claudeArgs?.includes('--continue') || opts.claudeArgs?.includes('-c');
    const hasResumeFlag = opts.claudeArgs?.includes('--resume') || opts.claudeArgs?.includes('-r');
    const hasUserSessionControl = hasContinueFlag || hasResumeFlag;

    // Determine if we have an existing session to resume
    // Session ID will always be provided by hook (SessionStart) when Claude starts
    let startFrom = opts.sessionId;

    // Handle session-related flags from claudeArgs to ensure transparent behavior
    // We intercept these flags to use Happier CLI's session storage rather than Claude's default
    //
    // Supported patterns:
    // --continue / -c           : Resume last session in current directory
    // --resume / -r             : Resume last session (picker in Claude, but we handle)
    // --resume <id> / -r <id>   : Resume specific session by ID
    // --session-id <uuid>       : Use specific UUID for new session

    // Helper to find and extract flag with optional value
    const extractFlag = (flags: string[], withValue: boolean = false): { found: boolean; value?: string } => {
        if (!opts.claudeArgs) return { found: false };

        for (const flag of flags) {
            const index = opts.claudeArgs.indexOf(flag);
            if (index !== -1) {
                if (withValue && index + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[index + 1];
                    // Check if next arg looks like a value (doesn't start with -)
                    if (!nextArg.startsWith('-')) {
                        const value = nextArg;
                        // Remove both flag and value
                        opts.claudeArgs = opts.claudeArgs.filter((_, i) => i !== index && i !== index + 1);
                        return { found: true, value };
                    }
                }
                // Don't extract if value was required but not found
                if (!withValue) {
                    opts.claudeArgs = opts.claudeArgs.filter((_, i) => i !== index);
                    return { found: true };
                }
                return { found: false };
            }
        }
        return { found: false };
    };

    // Session-flag interception is only needed in offline mode (no hook server),
    // where we must determine the session ID ourselves.
    let sessionIdFlag: { found: boolean; value?: string } = { found: false };
    if (!opts.hookSettingsPath) {
        // 1. Check for --session-id <uuid> (explicit new session with specific ID)
        sessionIdFlag = extractFlag(['--session-id'], true);
        if (sessionIdFlag.found && sessionIdFlag.value) {
            startFrom = null; // Force new session mode, will use this ID below
            logger.debug(`[ClaudeLocal] Using explicit --session-id: ${sessionIdFlag.value}`);
        }

        // 2. Check for --resume <id> / -r <id> (resume specific session)
        if (!startFrom && !sessionIdFlag.value) {
            const resumeFlag = extractFlag(['--resume', '-r'], true);
            if (resumeFlag.found) {
                if (resumeFlag.value) {
                    startFrom = resumeFlag.value;
                    logger.debug(`[ClaudeLocal] Using provided session ID from --resume: ${startFrom}`);
                } else {
                    // --resume without value: find last session
                    const lastSession = claudeFindLastSession(opts.path, claudeConfigDir);
                    if (lastSession) {
                        startFrom = lastSession;
                        logger.debug(`[ClaudeLocal] --resume: Found last session: ${lastSession}`);
                    }
                }
            }
        }

        // 3. Check for --continue / -c (resume last session)
        if (!startFrom && !sessionIdFlag.value) {
            const continueFlag = extractFlag(['--continue', '-c'], false);
            if (continueFlag.found) {
                const lastSession = claudeFindLastSession(opts.path, claudeConfigDir);
                if (lastSession) {
                    startFrom = lastSession;
                    logger.debug(`[ClaudeLocal] --continue: Found last session: ${lastSession}`);
                }
            }
        }
    }
    // Session ID handling depends on whether we have a hook server
    // - With hookSettingsPath: Session ID comes from Claude via hook (normal mode)
    // - Without hookSettingsPath: We generate session ID ourselves (offline mode)
    const explicitSessionId = sessionIdFlag.value || null;
    let newSessionId: string | null = null;
    let effectiveSessionId: string | null = startFrom;

    if (!opts.hookSettingsPath) {
        // Offline mode: Generate session ID if not resuming
        // Priority: 1. startFrom (resuming), 2. explicit --session-id, 3. generate new UUID
        newSessionId = startFrom ? null : (explicitSessionId || randomUUID());
        effectiveSessionId = startFrom || newSessionId!;

        // Notify about session ID immediately (we know it upfront in offline mode)
        if (startFrom) {
            logger.debug(`[ClaudeLocal] Resuming session: ${startFrom}`);
            opts.onSessionFound(startFrom);
        } else if (explicitSessionId) {
            logger.debug(`[ClaudeLocal] Using explicit session ID: ${explicitSessionId}`);
            opts.onSessionFound(explicitSessionId);
        } else {
            logger.debug(`[ClaudeLocal] Generated new session ID: ${newSessionId}`);
            opts.onSessionFound(newSessionId!);
        }
    } else {
        // Normal mode with hook server: Session ID comes from Claude via hook
        if (startFrom) {
            logger.debug(`[ClaudeLocal] Will resume existing session: ${startFrom}`);
        } else if (hasUserSessionControl) {
            logger.debug(`[ClaudeLocal] User passed ${hasContinueFlag ? '--continue' : '--resume'} flag, session ID will be determined by hook`);
        } else {
            logger.debug(`[ClaudeLocal] Fresh start, session ID will be provided by hook`);
        }
    }

    // Thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[ClaudeLocal] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };
    let stopThinkingTimeout: ReturnType<typeof setTimeout> | null = null;
    const activeFetchIds = new Set<string>();
    const clearStopThinkingTimeout = () => {
        if (!stopThinkingTimeout) return;
        clearTimeout(stopThinkingTimeout);
        stopThinkingTimeout = null;
    };
    const readFetchId = (message: { id?: unknown }): string => {
        const id = message.id;
        if (typeof id === 'string' && id.length > 0) return id;
        if (typeof id === 'number' && Number.isFinite(id)) return String(id);
        return CLAUDE_LOCAL_UNKNOWN_FETCH_ID;
    };
    const scheduleThinkingClearIfIdle = () => {
        if (activeFetchIds.size > 0 || !thinking || stopThinkingTimeout) return;
        stopThinkingTimeout = setTimeout(() => {
            stopThinkingTimeout = null;
            if (activeFetchIds.size === 0) {
                opts.onLifecycleGapDetected?.({
                    source: 'fd3_fetch_fallback',
                    signal: 'fetch_idle_clear',
                    activeFetchCount: activeFetchIds.size,
                });
                updateThinking(false);
            }
        }, CLAUDE_LOCAL_FETCH_IDLE_CLEAR_DELAY_MS);
        stopThinkingTimeout.unref?.();
    };

    let materializedMcpConfig: MaterializedClaudeMcpConfigArgs | null = null;

    // Spawn the process
    try {
        // Start the interactive process
        restoreStdinBestEffort({ stdin: process.stdin as any });
        const resolvedClaudeCliPath = resolveClaudeCliPath();
        const shouldUseNodeLauncher = isClaudeCliJavaScriptFile(resolvedClaudeCliPath);
        const nodeExecutable = shouldUseNodeLauncher
            ? await ensureClaudeJsRuntimeExecutable()
            : null;
        materializedMcpConfig = await materializeClaudeMcpConfigArgsForSpawn([
            ...(opts.claudeArgs ?? []),
            ...(typeof opts.happierMcpConfigJson === 'string' && opts.happierMcpConfigJson.trim().length > 0
                ? ['--mcp-config', opts.happierMcpConfigJson.trim()]
                : []),
        ]);
        const effectiveClaudeArgs = materializedMcpConfig.args;
        await new Promise<void>((r, reject) => {
            const args: string[] = []

            // Session/resume args depend on whether we're in offline mode or hook mode
            if (!opts.hookSettingsPath) {
                // Offline mode: We control session ID
                if (startFrom) {
                    // Resume existing session (Claude preserves the session ID)
                    args.push('--resume', startFrom)
                } else if (!hasResumeFlag && newSessionId) {
                    // New session with our generated UUID
                    args.push('--session-id', newSessionId)
                }
            } else {
                // Normal mode with hook: Add --resume if we found a session to resume
                // (Flags have been extracted, so we re-add --resume with the session ID we found)
                if (startFrom) {
                    args.push('--resume', startFrom);
                }
            }
            // If hasResumeFlag && !startFrom: --resume is in claudeArgs, let Claude handle it

            const systemPromptText = typeof opts.systemPromptText === 'string' ? opts.systemPromptText.trim() : '';
            const fallbackPrompt = (() => {
                const providerBlocks = getClaudeSystemPrompt();
                const base = HAPPIER_BASE_SYSTEM_PROMPT_V1;
                return providerBlocks.trim().length > 0 ? `${base}\n\n${providerBlocks}` : base;
            })();
            args.push('--append-system-prompt', systemPromptText || fallbackPrompt);

            // Claude CLI treats the first non-flag token as the prompt. If a positional prompt
            // is provided before later flags, those flags can be mis-parsed as prompt text.
            // Ensure positional args come after all flags (including our injected --settings).
            const flagArgs: string[] = [];
            const positionalArgs: string[] = [];
            let trailingPermissionFlagArgs: string[] = [];

            if (effectiveClaudeArgs.length > 0) {
                for (let i = 0; i < effectiveClaudeArgs.length; i++) {
                    const arg = effectiveClaudeArgs[i];
                    if (arg === '--dangerously-skip-permissions') {
                        trailingPermissionFlagArgs = ['--permission-mode', 'bypassPermissions'];
                        continue;
                    }
                    if (arg === '--permission-mode') {
                        const nextArg = i + 1 < effectiveClaudeArgs.length ? effectiveClaudeArgs[i + 1] : undefined;
                        if (typeof nextArg === 'string' && !nextArg.startsWith('-')) {
                            trailingPermissionFlagArgs = ['--permission-mode', nextArg];
                            i++;
                            continue;
                        }
                    }
                    if (arg.startsWith('--permission-mode=')) {
                        const normalizedValue = arg.slice('--permission-mode='.length).trim();
                        if (normalizedValue) {
                            trailingPermissionFlagArgs = ['--permission-mode', normalizedValue];
                            continue;
                        }
                    }
                    if (arg.startsWith('-')) {
                        flagArgs.push(arg);
                        const nextArg = i + 1 < effectiveClaudeArgs.length ? effectiveClaudeArgs[i + 1] : undefined;
                        if (claudeCliFlagCanConsumeNextArg(arg, nextArg)) {
                            flagArgs.push(nextArg!);
                            i++;
                        }
                        continue;
                    }
                    positionalArgs.push(arg);
                }
            }

            // Happier-injected flags were appended before parsing so user ordering stays intact.
            //
            // Claude Code merges multiple `--mcp-config` sources additively and uses last-write-wins on collisions.
            // Appending here means we do not need to parse/merge user JSON and Happier wins on collisions.
            //
            // `--settings` is treated as a single overlay for the hooks field: when more than one
            // --settings flag is passed, only the first wins and the rest are silently dropped.
            // Any PATH-resident wrapper that prepends its own --settings (cmux's claude wrapper is
            // our in-the-wild case) therefore silently discards Happier's hook block. We carry
            // non-hook config (permissions.allow) in --settings and move hooks to --plugin-dir,
            // which is additive across multiple invocations so wrappers and Happier coexist.
            if (opts.hookPluginDir) {
                flagArgs.push('--plugin-dir', opts.hookPluginDir);
                logger.debug(`[ClaudeLocal] Using hook plugin dir: ${opts.hookPluginDir}`);
            }
            const permissionMode = trailingPermissionFlagArgs[0] === '--permission-mode'
                ? trailingPermissionFlagArgs[1]
                : undefined;
            const settingsOverlay = resolveClaudeLaunchSettingsOverlayArg({
                settingsPath: opts.hookSettingsPath,
                launchSettings: buildClaudePermissionModeLaunchSettings(permissionMode),
            });
            if (settingsOverlay) {
                flagArgs.push('--settings', settingsOverlay);
                logger.debug(`[ClaudeLocal] Using launch settings: ${settingsOverlay}`);
            }
            // Add flag arguments before positional prompts.
            if (flagArgs.length > 0) {
                args.push(...flagArgs);
            }
            if (trailingPermissionFlagArgs.length > 0) {
                args.push(...trailingPermissionFlagArgs);
            }
            if (positionalArgs.length > 0) {
                // Claude Code treats some flags (notably `--mcp-config`) as variadic, so they will
                // greedily consume subsequent non-flag tokens. Without a `--` delimiter, a user
                // prompt can be mis-parsed as an additional MCP config path, causing the session
                // to start without the initial prompt (or erroring if the prompt is not a file).
                //
                // Delimit positional args whenever a variadic flag is present in the final args.
                const hasVariadicFlag =
                    flagArgs.includes('--mcp-config') ||
                    flagArgs.some((arg) => typeof arg === 'string' && arg.startsWith('--mcp-config='));
                if (hasVariadicFlag) {
                    args.push('--');
                }
                args.push(...positionalArgs);
            }

            // Prepare environment variables
            // Note: Local mode uses global Claude installation with --session-id flag
            // Launcher only intercepts fetch for thinking state tracking
            const env: NodeJS.ProcessEnv = stripNestedSessionDetectionEnv({
                ...processEnv,
                // Keep behavior consistent with our wrapper script.
                DISABLE_AUTOUPDATER: '1',
                ...resolveClaudeConfigDirEnvOverlay(processEnv),
                ...(opts.envOverlay ?? {}),
            })
            isolateClaudeRuntimeAuthEnv(env);
            // Internal daemon→CLI marker used for strict env filtering in Agent SDK remote mode.
            // Never forward it into the Claude Code subprocess environment.
            delete env[HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR];
            logClaudeRuntimeAuthEnvDiagnostic({
                logPrefix: 'ClaudeLocal',
                sessionId: opts.sessionId,
                startFrom,
                runnerEnv: processEnv,
                childEnv: env,
            });

            if (shouldUseNodeLauncher) {
                if (!claudeCliPath || (!existsSync(claudeCliPath) && !isEmbeddedBunBundlePath(claudeCliPath))) {
                    throw new Error('Claude local launcher not found. Please ensure CLI runtime assets are present next to the running bundle.');
                }

                // Avoid re-running auto-discovery inside the node wrapper (saves filesystem work).
                if (!env.HAPPIER_CLAUDE_PATH && !env.HAPPY_CLAUDE_PATH) {
                    env.HAPPIER_CLAUDE_PATH = resolvedClaudeCliPath;
                }
            }

            logger.debug(
                `[ClaudeLocal] Spawning ${shouldUseNodeLauncher ? 'node launcher' : 'Claude'}: ${shouldUseNodeLauncher ? claudeCliPath : resolvedClaudeCliPath}`,
            );
            logger.debug(`[ClaudeLocal] Args: ${JSON.stringify(redactClaudeArgsForLog(args))}`);

            // Fail closed if node launcher is required but no JavaScript runtime is available
            if (shouldUseNodeLauncher && !nodeExecutable) {
                throw new ReferenceError(buildMissingJavaScriptRuntimeMessage('Claude Code launcher'));
            }

            const invocation: CommandInvocation = shouldUseNodeLauncher
                ? { command: nodeExecutable!, args: [claudeCliPath, ...args] }
                : resolveWindowsCommandInvocation({ command: resolvedClaudeCliPath, args, env });

            const child = spawn(invocation.command, invocation.args, {
                stdio: shouldUseNodeLauncher ? ['inherit', 'inherit', 'inherit', 'pipe'] : ['inherit', 'inherit', 'inherit', 'ignore'],
                cwd: opts.path,
                env,
                windowsHide: true,
                ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            });

            // Prefer a graceful shutdown path when the launcher is aborted (mode switching, UI takeover).
            // Node's `signal:` AbortSignal option would immediately SIGTERM the child; that can leave
            // Claude transcripts in a less resumable state (and may cause resume to fail under Agent SDK).
            // Instead: send SIGINT first, then escalate if needed.
            const abortFirstSignal: NodeJS.Signals = process.platform === 'win32' ? 'SIGTERM' : 'SIGINT';
            const abortSecondSignal: NodeJS.Signals = 'SIGTERM';
            const abortThirdSignal: NodeJS.Signals = 'SIGKILL';
            const abortEscalateAfterMsRaw = configuration.claudeLocalAbortEscalateAfterMs;
            const abortKillAfterMsRaw = configuration.claudeLocalAbortKillAfterMs;
            const abortEscalateAfterMs =
                Number.isFinite(abortEscalateAfterMsRaw) && abortEscalateAfterMsRaw > 0 ? abortEscalateAfterMsRaw : 0;
            const abortKillAfterMs =
                Number.isFinite(abortKillAfterMsRaw) && abortKillAfterMsRaw > 0 ? abortKillAfterMsRaw : 0;
            const effectiveAbortKillAfterMs =
                abortKillAfterMs > 0 && abortEscalateAfterMs > 0 ? Math.max(abortKillAfterMs, abortEscalateAfterMs + 1) : abortKillAfterMs;

            let abortTeardownRequested = false;
            let abortEscalateTimer: NodeJS.Timeout | null = null;
            let abortKillTimer: NodeJS.Timeout | null = null;
            const clearAbortTimers = () => {
                if (abortEscalateTimer) {
                    clearTimeout(abortEscalateTimer);
                    abortEscalateTimer = null;
                }
                if (abortKillTimer) {
                    clearTimeout(abortKillTimer);
                    abortKillTimer = null;
                }
            };

            let abortListenerAttached = false;
            const abortListener = () => {
                abortTeardownRequested = true;
                if (!child.pid || child.killed) return;
                try {
                    child.kill(abortFirstSignal);
                } catch {
                    // ignore
                }

                clearAbortTimers();

                if (abortEscalateAfterMs > 0) {
                    abortEscalateTimer = setTimeout(() => {
                        if (!child.pid || child.killed) return;
                        try {
                            child.kill(abortSecondSignal);
                        } catch {
                            // ignore
                        }
                    }, abortEscalateAfterMs);
                    abortEscalateTimer.unref?.();
                }

                if (effectiveAbortKillAfterMs > 0) {
                    abortKillTimer = setTimeout(() => {
                        if (!child.pid || child.killed) return;
                        try {
                            child.kill(abortThirdSignal);
                        } catch {
                            // ignore
                        }
                    }, effectiveAbortKillAfterMs);
                    abortKillTimer.unref?.();
                }
            };

            if (opts.abort.aborted) {
                abortListener();
            } else {
                opts.abort.addEventListener('abort', abortListener, { once: true });
                abortListenerAttached = true;
            }

            // Forward signals to child process to prevent orphaned processes
            // Note: we implement programmatic abort (AbortSignal) ourselves above to be graceful.
            // Direct OS signals (e.g., kill, Ctrl+C) still need explicit forwarding.
            attachProcessSignalForwardingToChild(child);

            // Listen to the custom fd (fd 3) for thinking state tracking
            if (shouldUseNodeLauncher && child.stdio[3]) {
                const rl = createInterface({
                    input: child.stdio[3] as any,
                    crlfDelay: Infinity
                });

                rl.on('line', (line) => {
                    try {
                        const message = JSON.parse(line);

                        switch (message.type) {
                            case 'fetch-start':
                                clearStopThinkingTimeout();
                                activeFetchIds.add(readFetchId(message));
                                opts.onLifecycleGapDetected?.({
                                    source: 'fd3_fetch_fallback',
                                    signal: 'fetch_start',
                                    activeFetchCount: activeFetchIds.size,
                                });
                                updateThinking(true);
                                break;

                            case 'fetch-end':
                                activeFetchIds.delete(readFetchId(message));
                                scheduleThinkingClearIfIdle();
                                break;

                            default:
                                logger.debug(`[ClaudeLocal] Unknown message type: ${message.type}`);
                        }
                    } catch (e) {
                        // Not JSON, ignore (could be other output)
                        logger.debug(`[ClaudeLocal] Non-JSON line from fd3: ${line}`);
                    }
                });

                rl.on('error', (err) => {
                    console.error('Error reading from fd 3:', err);
                });

                // Cleanup on child exit
                child.on('exit', () => {
                    clearStopThinkingTimeout();
                    activeFetchIds.clear();
                    updateThinking(false);
                });
            }
            child.on('error', (error) => {
                // Ignore
            });
            child.on('exit', (code, signal) => {
                if (abortListenerAttached) {
                    try {
                        opts.abort.removeEventListener('abort', abortListener);
                    } catch {
                        // ignore
                    }
                    abortListenerAttached = false;
                }
                clearAbortTimers();

                if (abortTeardownRequested) {
                    // Normal termination due to programmatic abort teardown (switching modes / UI takeover).
                    // Do not treat exit codes as fatal while aborting: vendor CLIs sometimes exit with non-zero
                    // after SIGINT/SIGTERM even when shutdown is intentional.
                    r();
                } else if (signal) {
                    reject(new Error(`Process terminated with signal: ${signal}`));
                } else if (code !== 0 && code !== null) {
                    // Non-zero exit code - propagate it
                    reject(new ExitCodeError(code));
                } else {
                    r();
                }
            });
        });
    } finally {
        await materializedMcpConfig?.cleanup();
        process.stdin.resume();
        clearStopThinkingTimeout();
        activeFetchIds.clear();
        updateThinking(false);
    }

    // Return the effective session ID (what was actually used)
    // - In offline mode: Our generated or resumed session ID
    // - In hook mode: The session ID from startFrom (if resuming) or null (new session - hook will report ID)
    return effectiveSessionId;
}
