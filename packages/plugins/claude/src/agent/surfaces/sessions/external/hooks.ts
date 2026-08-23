import { join } from 'node:path';

import type {
    AgentExternalSessionHooksContribution,
    AgentExternalSessionsFailureCode,
    AgentExternalSessionsResult,
} from '@happier-dev/plugin-sdk/sessions/external';

import { resolveConfiguredClaudeConfigDir } from './source.js';

export const CLAUDE_EXTERNAL_SESSION_HOOK_SUPPORTED_VERSION = '2.1.217' as const;
export const CLAUDE_EXTERNAL_SESSION_HOOK_INSTALLATION_VARIANT_ID =
    'claude-session-lifecycle-v1' as const;
/**
 * Windows Claude Code runs a hook entry through whichever shell the platform
 * hands it, so a POSIX-quoted command is not executable there. The plugin's own
 * session-hook writer already installs the encoded-PowerShell form on win32
 * (`agent/hooks/settings.ts`), and this variant keeps External Session hooks on
 * that same proven serialization.
 */
export const CLAUDE_EXTERNAL_SESSION_HOOK_WINDOWS_VARIANT_ID =
    'claude-session-lifecycle-windows-v1' as const;
export const CLAUDE_EXTERNAL_SESSION_HOOK_SETTINGS_TARGET_ID =
    'claude-user-settings' as const;
export const CLAUDE_EXTERNAL_SESSION_HOOK_SETTINGS_COLLECTION_ID =
    'claude-user-hooks' as const;
export const CLAUDE_EXTERNAL_SESSION_HOOK_SESSION_START_EVENT_ID =
    'claude-session-start' as const;
export const CLAUDE_EXTERNAL_SESSION_HOOK_STOP_EVENT_ID =
    'claude-stop' as const;

const CLAUDE_STOP_IDLE_TTL_MS = 15_000;
const CLAUDE_SESSION_START_SOURCES = new Set([
    'startup',
    'resume',
    'clear',
    'compact',
]);

type PlainRecord = Readonly<Record<string, unknown>>;

function ok<T>(value: T): AgentExternalSessionsResult<T> {
    return { ok: true, value };
}

function failed(
    code: AgentExternalSessionsFailureCode,
    message: string,
    retryable?: boolean,
): AgentExternalSessionsResult<never> {
    return {
        ok: false,
        code,
        message,
        ...(retryable === undefined ? {} : { retryable }),
    };
}

function invocationFailure(request: Readonly<{
    signal: AbortSignal;
    deadlineAtMs: number;
    maxSerializedBytes: number;
}>): AgentExternalSessionsResult<never> | null {
    if (request.signal.aborted) {
        return failed('cancelled', 'Claude External Session hook callback was cancelled.');
    }
    if (Date.now() >= request.deadlineAtMs) {
        return failed(
            'timeout',
            'Claude External Session hook callback exceeded its deadline.',
            true,
        );
    }
    if (!Number.isFinite(request.maxSerializedBytes) || request.maxSerializedBytes < 1) {
        return failed(
            'invalid_request',
            'Claude External Session hook result byte bound must be positive.',
        );
    }
    return null;
}

function readRecord(value: unknown): PlainRecord | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null
        ? value as PlainRecord
        : null;
}

function readNonemptyString(value: unknown): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : null;
}

function readInstalledVersion(value: string): string {
    return value.match(/(?:^|\D)(\d+\.\d+\.\d+)(?:\D|$)/u)?.[1]
        ?? value.trim();
}

function sourceInput() {
    return { kind: 'claudeConfig' } as const;
}

function installationVariant(
    variantId: string,
    shellDialect: 'posix' | 'powershell_encoded',
) {
    return Object.freeze({
        variantId,
        targets: Object.freeze([Object.freeze({
            targetId: CLAUDE_EXTERNAL_SESSION_HOOK_SETTINGS_TARGET_ID,
            format: 'hook_event_json_arrays_v1' as const,
            collectionId: CLAUDE_EXTERNAL_SESSION_HOOK_SETTINGS_COLLECTION_ID,
        })]),
        events: Object.freeze([
            Object.freeze({
                eventId: CLAUDE_EXTERNAL_SESSION_HOOK_SESSION_START_EVENT_ID,
                targetId: CLAUDE_EXTERNAL_SESSION_HOOK_SETTINGS_TARGET_ID,
                nativeEventName: 'SessionStart',
                command: Object.freeze({
                    kind: 'happier_observation_v1' as const,
                    shellDialect,
                    timeoutMs: 500,
                }),
            }),
            Object.freeze({
                eventId: CLAUDE_EXTERNAL_SESSION_HOOK_STOP_EVENT_ID,
                targetId: CLAUDE_EXTERNAL_SESSION_HOOK_SETTINGS_TARGET_ID,
                nativeEventName: 'Stop',
                command: Object.freeze({
                    kind: 'happier_observation_v1' as const,
                    shellDialect,
                    timeoutMs: 500,
                }),
            }),
        ]),
    });
}

const INSTALLATION_VARIANT_IDS: ReadonlySet<string> = new Set([
    CLAUDE_EXTERNAL_SESSION_HOOK_INSTALLATION_VARIANT_ID,
    CLAUDE_EXTERNAL_SESSION_HOOK_WINDOWS_VARIANT_ID,
]);

export const claudeExternalSessionHooksContribution =
    Object.freeze({
        installationVariants: Object.freeze([
            installationVariant(
                CLAUDE_EXTERNAL_SESSION_HOOK_INSTALLATION_VARIANT_ID,
                'posix',
            ),
            installationVariant(
                CLAUDE_EXTERNAL_SESSION_HOOK_WINDOWS_VARIANT_ID,
                'powershell_encoded',
            ),
        ]),

        resolveInstallation(request) {
            const stopped = invocationFailure(request);
            if (stopped) return stopped;
            if (
                readInstalledVersion(request.installation.installedVersion)
                !== CLAUDE_EXTERNAL_SESSION_HOOK_SUPPORTED_VERSION
            ) {
                return ok({
                    kind: 'unsupported' as const,
                    reason: 'version_unsupported' as const,
                });
            }

            const configDir = resolveConfiguredClaudeConfigDir({ env: process.env });
            return ok({
                kind: 'supported' as const,
                variantId: request.installation.platform === 'win32'
                    ? CLAUDE_EXTERNAL_SESSION_HOOK_WINDOWS_VARIANT_ID
                    : CLAUDE_EXTERNAL_SESSION_HOOK_INSTALLATION_VARIANT_ID,
                targets: [{
                    targetId: CLAUDE_EXTERNAL_SESSION_HOOK_SETTINGS_TARGET_ID,
                    absolutePath: join(configDir, 'settings.json'),
                }],
                readiness: { kind: 'ready' as const },
            });
        },

        mapHookEvent(request) {
            const stopped = invocationFailure(request);
            if (stopped) return stopped;
            if (!INSTALLATION_VARIANT_IDS.has(request.variantId)) {
                return ok({ kind: 'ignored' as const });
            }

            const payload = readRecord(request.nativePayload);
            if (!payload) return ok({ kind: 'ignored' as const });
            const hookEventName = readNonemptyString(payload.hook_event_name);
            const remoteSessionId = readNonemptyString(payload.session_id);
            if (!remoteSessionId) return ok({ kind: 'ignored' as const });

            if (
                request.eventId
                === CLAUDE_EXTERNAL_SESSION_HOOK_SESSION_START_EVENT_ID
            ) {
                const startSource = readNonemptyString(payload.source);
                if (
                    hookEventName !== 'SessionStart'
                    || !startSource
                    || !CLAUDE_SESSION_START_SOURCES.has(startSource)
                ) {
                    return ok({ kind: 'ignored' as const });
                }
                return ok({
                    kind: 'mapped' as const,
                    sourceInput: sourceInput(),
                    remoteSessionId,
                    facts: [],
                });
            }

            if (request.eventId !== CLAUDE_EXTERNAL_SESSION_HOOK_STOP_EVENT_ID) {
                return ok({ kind: 'ignored' as const });
            }
            if (
                hookEventName !== 'Stop'
                || payload.stop_hook_active !== false
            ) {
                return ok({ kind: 'ignored' as const });
            }

            return ok({
                kind: 'mapped' as const,
                sourceInput: sourceInput(),
                remoteSessionId,
                facts: [
                    {
                        kind: 'turn_phase' as const,
                        value: 'idle' as const,
                        evidenceClass: 'qualified_hook' as const,
                        observedAtMs: request.observedAtMs,
                        expiresAtMs:
                            request.observedAtMs + CLAUDE_STOP_IDLE_TTL_MS,
                    },
                ],
            });
        },
    }) satisfies AgentExternalSessionHooksContribution;
