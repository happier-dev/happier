import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';

import { PluginError, type PluginDiagnosticData } from '@happier-dev/plugin-sdk';

import type {
    SystemToolDiagnosticV1,
    SystemToolLaunchGrantV1,
    SystemToolResolveRequestV1,
    SystemToolSourceV1,
} from '../../privateContract';
import {
    agentCliPathRequiresJavaScriptRuntime,
    resolveAgentCliJavaScriptRuntimeCommand,
} from '@happier-dev/cli-common/agents/resolution';

import {
    isPluginExecSystemToolSupportedOnHost,
    type PluginExecSystemToolDefinition,
    type PluginExecSystemToolGrantRecord,
    type PluginExecSystemToolReadiness,
} from './definitions';
import {
    createLegacySystemToolDiagnostic,
    createMissingSystemToolDiagnostic,
    MISSING_SYSTEM_TOOL_DETAILS,
    createSystemToolDiagnostic,
    createUnidentifiedSystemToolDiagnostic,
} from './diagnostics';
import { resolveSystemToolReadiness } from './readiness';
import { resolveSystemToolLookupCandidates } from './lookupCandidates';
import { isDeniedPathOnlyRuntimeName, normalizePathOnlyRuntimeName } from './runtimeDeny';

function projectSystemToolDiagnostics(
    diagnostics: readonly SystemToolDiagnosticV1[],
): readonly PluginDiagnosticData[] {
    return Object.freeze(diagnostics.map((diagnostic) => Object.freeze({
        code: diagnostic.code,
        severity: diagnostic.severity,
    })));
}

export type CreatePluginExecSystemToolResolverParams = Readonly<{
    definitions?: readonly PluginExecSystemToolDefinition[];
    baseEnv?: Readonly<Record<string, string>>;
    /**
     * Host-private exception for an exact preferred path that the canonical
     * Agent CLI resolver has already classified as a JavaScript entrypoint.
     */
    preferredPathAccess?: 'executable-only' | 'readable-javascript';
    registerGrant: (grant: PluginExecSystemToolGrantRecord) => void;
    now?: () => number;
    /**
     * Selects Windows executable-name resolution (`PATHEXT` shims); defaults to
     * this process. It does not emulate any other platform behavior — `PATH`
     * itself is still split with this process's delimiter — so it exists to make
     * the Windows lookup branch testable, not to run a Windows host elsewhere.
     */
    platform?: NodeJS.Platform;
}>;

function createAbortError(): PluginError {
    return new PluginError({
        code: 'plugin_exec_system_tool_aborted',
        message: 'System tool resolution was aborted',
        diagnostics: projectSystemToolDiagnostics([createSystemToolDiagnostic({
            code: 'system_tool_aborted',
            severity: 'warning',
            messageKey: 'plugins.exec.systemTools.aborted',
        })]),
    });
}

function createDeniedSystemToolError(params: Readonly<{
    definition: PluginExecSystemToolDefinition;
    executablePath: string;
}>): PluginError {
    const executableName = basename(params.executablePath);
    return new PluginError({
        code: 'plugin_exec_system_tool_denied',
        message: `System tool '${params.definition.displayName}' resolves to a managed runtime/package-manager executable`,
        diagnostics: projectSystemToolDiagnostics([createSystemToolDiagnostic({
            code: 'system_tool_denied',
            severity: 'error',
            messageKey: 'plugins.exec.systemTools.denied',
            detail: {
                toolId: params.definition.toolId,
                displayName: params.definition.displayName,
                executableName,
                normalizedName: normalizePathOnlyRuntimeName(executableName),
            },
        })]),
    });
}

async function isExecutableFile(path: string): Promise<boolean> {
    try {
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

async function isReadableJavaScriptFile(path: string): Promise<boolean> {
    if (!agentCliPathRequiresJavaScriptRuntime(path)) {
        return false;
    }
    try {
        const metadata = await stat(path);
        if (!metadata.isFile()) return false;
        await access(path, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

function resolveCanonicalAgentCliJavaScriptLaunch(
    executablePath: string,
    defaultArgs: readonly string[] | undefined,
    processEnv: NodeJS.ProcessEnv = process.env,
): Readonly<{ executablePath: string; args: readonly string[] }> | null {
    const runtimeCommand = resolveAgentCliJavaScriptRuntimeCommand(executablePath, processEnv, {
        isBunRuntime: typeof process.versions.bun === 'string',
        currentExecPath: process.execPath,
    });
    if (!runtimeCommand) return null;
    return Object.freeze({
        executablePath: runtimeCommand,
        args: Object.freeze([executablePath, ...(defaultArgs ?? [])]),
    });
}

function createGrantId(params: Readonly<{
    toolId: string;
    executablePath: string;
    issuedAt: number;
}>): string {
    const digest = createHash('sha256')
        .update(params.toolId)
        .update('\0')
        .update(params.executablePath)
        .update('\0')
        .update(String(params.issuedAt))
        .digest('hex')
        .slice(0, 16);
    return `system-tool:${digest}`;
}

function normalizeLookupCandidates(
    definition: PluginExecSystemToolDefinition,
    request: SystemToolResolveRequestV1,
    env: Readonly<Record<string, string>>,
    platform: NodeJS.Platform,
): readonly string[] {
    const candidates: string[] = [];
    const pushCandidate = (candidate: string) => {
        if (!candidates.includes(candidate)) {
            candidates.push(candidate);
        }
    };
    const pushLookupName = (lookupName: string) => {
        for (const candidate of resolveSystemToolLookupCandidates(lookupName, env, platform)) pushCandidate(candidate);
    };
    if (typeof request.preferredPath === 'string' && request.preferredPath.trim().length > 0) {
        pushCandidate(request.preferredPath.trim());
    }
    if (typeof definition.executablePath === 'string' && definition.executablePath.trim().length > 0) {
        pushCandidate(definition.executablePath.trim());
    }
    const preferredCommand = normalizePreferredCommand(request.preferredCommand);
    if (preferredCommand !== null) {
        pushLookupName(preferredCommand);
    }
    for (const lookupName of definition.lookupNames ?? []) {
        pushLookupName(lookupName);
    }
    return candidates;
}

function classifySource(
    definition: PluginExecSystemToolDefinition,
    request: SystemToolResolveRequestV1,
    executablePath: string,
): SystemToolSourceV1 {
    if (request.preferredPath && request.preferredPath.trim() === executablePath) {
        return 'user_config';
    }
    return definition.source ?? 'system';
}

function readCaseInsensitiveEnvValue(
    env: Readonly<Record<string, string | undefined>> | undefined,
    name: string,
): string | undefined {
    // Windows environment names are case-insensitive and Node may surface
    // `Path`/`Pathext` rather than the uppercase spelling.
    const direct = env?.[name];
    if (typeof direct === 'string') return direct;
    const lowered = name.toLowerCase();
    for (const [key, value] of Object.entries(env ?? {})) {
        if (key.toLowerCase() === lowered && typeof value === 'string') return value;
    }
    return undefined;
}

/**
 * The lookup environment stays deliberately narrow so tool resolution cannot
 * read ambient configuration. `PATHEXT` belongs with `PATH`: on Windows it is
 * half of "which filenames count as this command", and dropping it silently
 * pins every lookup to the default extension list instead of the user's.
 */
function buildSystemToolLookupEnv(baseEnv: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
    const pathext = readCaseInsensitiveEnvValue(baseEnv, 'PATHEXT')
        ?? readCaseInsensitiveEnvValue(process.env, 'PATHEXT');
    return Object.freeze({
        PATH: readCaseInsensitiveEnvValue(baseEnv, 'PATH') ?? process.env.PATH ?? '',
        ...(pathext === undefined ? {} : { PATHEXT: pathext }),
    });
}

function normalizePreferredCommand(preferredCommand: string | null | undefined): string | null {
    if (typeof preferredCommand !== 'string') {
        return null;
    }
    const trimmed = preferredCommand.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function isCommandName(value: string): boolean {
    return !isAbsolute(value) && !value.includes('/') && !value.includes('\\');
}

function validatePreferredCommand(
    definition: PluginExecSystemToolDefinition,
    request: SystemToolResolveRequestV1,
): void {
    const preferredCommand = normalizePreferredCommand(request.preferredCommand);
    if (preferredCommand === null) {
        return;
    }
    const declaredLookupNames = new Set((definition.lookupNames ?? []).filter(isCommandName));
    if (!isCommandName(preferredCommand) || !declaredLookupNames.has(preferredCommand)) {
        throw new PluginError({
            code: 'plugin_exec_system_tool_invalid_command',
            message: `System tool '${request.toolId}' preferred command must be a declared lookup name`,
            diagnostics: projectSystemToolDiagnostics([createSystemToolDiagnostic({
                code: 'system_tool_invalid_command',
                severity: 'error',
                messageKey: 'plugins.exec.systemTools.invalidCommand',
                detail: {
                    toolId: request.toolId,
                    displayName: definition.displayName,
                    preferredCommand,
                },
            })]),
        });
    }
}

export function createPluginExecSystemToolResolver(params: CreatePluginExecSystemToolResolverParams) {
    const definitions = new Map<string, PluginExecSystemToolDefinition>();
    for (const definition of params.definitions ?? []) {
        definitions.set(definition.toolId, definition);
    }

    function assertNotAborted(signal: AbortSignal | undefined): void {
        if (signal?.aborted) {
            throw createAbortError();
        }
    }

    return Object.freeze({
        async resolve(request: SystemToolResolveRequestV1): Promise<SystemToolLaunchGrantV1> {
            assertNotAborted(request.signal);
            const definition = definitions.get(request.toolId);
            if (!definition) {
                throw new PluginError({
                    code: 'plugin_exec_system_tool_undeclared',
                    message: `System tool '${request.toolId}' is not declared for this plugin runtime`,
                    diagnostics: projectSystemToolDiagnostics([createSystemToolDiagnostic({
                        code: 'system_tool_undeclared',
                        severity: 'error',
                        messageKey: 'plugins.exec.systemTools.undeclared',
                        detail: { toolId: request.toolId },
                    })]),
                });
            }
            // Narrowed once for the nested resolution helpers below, which
            // cannot rely on control-flow narrowing of the captured binding.
            const tool = definition;
            if (!isPluginExecSystemToolSupportedOnHost(definition, process.platform)) {
                throw new PluginError({
                    code: 'plugin_exec_system_tool_platform_unsupported',
                    message: `System tool '${definition.displayName}' is not supported on this host platform`,
                    diagnostics: projectSystemToolDiagnostics([createSystemToolDiagnostic({
                        code: 'system_tool_platform_unsupported',
                        severity: 'error',
                        messageKey: 'plugins.exec.systemTools.platformUnsupported',
                        detail: {
                            toolId: request.toolId,
                            displayName: definition.displayName,
                            platform: process.platform,
                        },
                    })]),
                });
            }

            const env = buildSystemToolLookupEnv(params.baseEnv);
            const invalidPreferredPath = typeof request.preferredPath === 'string'
                && request.preferredPath.trim().length > 0
                && !isAbsolute(request.preferredPath.trim());
            if (invalidPreferredPath) {
                throw new PluginError({
                    code: 'plugin_exec_system_tool_invalid_path',
                    message: `System tool '${request.toolId}' preferred path must be absolute`,
                    diagnostics: projectSystemToolDiagnostics([createSystemToolDiagnostic({
                        code: 'system_tool_invalid_path',
                        severity: 'error',
                        messageKey: 'plugins.exec.systemTools.invalidPath',
                        detail: {
                            toolId: request.toolId,
                            displayName: definition.displayName,
                            preferredPath: request.preferredPath,
                        },
                    })]),
                });
            }
            validatePreferredCommand(definition, request);
            const lookupPlatform = params.platform ?? process.platform;
            const candidates = normalizeLookupCandidates(
                definition,
                request,
                env,
                lookupPlatform,
            );

            async function resolveRunnableLaunch(candidate: string) {
                const isCanonicalReadableJavaScriptPath = (
                    params.preferredPathAccess === 'readable-javascript'
                    && request.preferredPath?.trim() === candidate
                    && await isReadableJavaScriptFile(candidate)
                );
                if (!(await isExecutableFile(candidate) || isCanonicalReadableJavaScriptPath)) {
                    return null;
                }
                return isCanonicalReadableJavaScriptPath
                    ? resolveCanonicalAgentCliJavaScriptLaunch(
                        candidate,
                        tool.defaultArgs,
                        params.baseEnv,
                    )
                    : Object.freeze({
                        executablePath: candidate,
                        args: Object.freeze([...(tool.defaultArgs ?? [])]),
                    });
            }

            function issueGrant(
                candidate: string,
                launch: Readonly<{ executablePath: string; args: readonly string[] }>,
            ): SystemToolLaunchGrantV1 {
                const issuedAt = params.now?.() ?? Date.now();
                const expiresAt = tool.expiresInMs === undefined || tool.expiresInMs === null
                    ? null
                    : issuedAt + Math.max(0, tool.expiresInMs);
                const grant: PluginExecSystemToolGrantRecord = Object.freeze({
                    kind: 'system-tool',
                    grantId: createGrantId({
                        toolId: tool.toolId,
                        executablePath: launch.executablePath,
                        issuedAt,
                    }),
                    toolId: tool.toolId,
                    executablePath: launch.executablePath,
                    expiresAt,
                });
                params.registerGrant(grant);
                return Object.freeze({
                    grantId: grant.grantId,
                    toolId: tool.toolId,
                    displayName: tool.displayName,
                    source: classifySource(tool, request, candidate),
                    executablePath: candidate,
                    launch: Object.freeze({
                        kind: 'binary',
                        executablePath: launch.executablePath,
                        cwd: request.cwd,
                        args: launch.args,
                        env: Object.freeze({
                            // The grant pins an absolute executable, not its descendants'
                            // command search environment. Leave the host PATH inherited.
                            ...(tool.env ?? {}),
                        }),
                    }),
                    ...(tool.allowedArguments ? {
                        allowedArguments: Object.freeze([...tool.allowedArguments]),
                    } : {}),
                    expiresAt,
                });
            }

            /**
             * Capability-based selection for tools that declare a readiness
             * probe. Runnable candidates are classified by observed command
             * behavior (ACP fingerprint plus command surface), never by version
             * output. Superseded executable names only inform the legacy
             * diagnostic; they are never granted or launched.
             */
            async function resolveWithReadiness(
                readiness: PluginExecSystemToolReadiness,
            ): Promise<SystemToolLaunchGrantV1 | null> {
                const preferredTrim = typeof request.preferredPath === 'string'
                    ? request.preferredPath.trim()
                    : '';
                const explicit = preferredTrim.length > 0;
                const scoped = explicit ? [preferredTrim] : candidates;
                const runnable: string[] = [];
                for (const candidate of scoped) {
                    assertNotAborted(request.signal);
                    if (!isAbsolute(candidate)) {
                        continue;
                    }
                    if (isDeniedPathOnlyRuntimeName(candidate)) {
                        throw createDeniedSystemToolError({
                            definition: tool,
                            executablePath: candidate,
                        });
                    }
                    if (await resolveRunnableLaunch(candidate)) {
                        runnable.push(candidate);
                    }
                }
                const runnableLegacy: string[] = [];
                for (const name of readiness.legacyExecutableNames) {
                    assertNotAborted(request.signal);
                    for (const candidate of resolveSystemToolLookupCandidates(name, env, lookupPlatform)) {
                        if (await resolveRunnableLaunch(candidate)) runnableLegacy.push(candidate);
                    }
                }
                assertNotAborted(request.signal);
                const verdict = await resolveSystemToolReadiness({
                    toolId: request.toolId,
                    readiness,
                    candidates: runnable,
                    explicitCandidate: explicit,
                    legacyCandidates: runnableLegacy,
                    cwd: request.cwd ?? process.cwd(),
                    env: { ...process.env },
                    signal: request.signal,
                });
                assertNotAborted(request.signal);
                if (verdict.kind === 'selected') {
                    const launch = await resolveRunnableLaunch(verdict.executablePath);
                    if (launch) return issueGrant(verdict.executablePath, launch);
                    return null;
                }
                if (verdict.kind === 'legacy') {
                    throw new PluginError({
                        code: 'plugin_exec_system_tool_legacy',
                        message: `${tool.displayName}: legacy runtime detected at ${verdict.observedPath}. ${readiness.legacyGuidance}`,
                        diagnostics: projectSystemToolDiagnostics([createLegacySystemToolDiagnostic({
                            toolId: tool.toolId,
                            displayName: tool.displayName,
                            observedPath: verdict.observedPath,
                            guidance: readiness.legacyGuidance,
                        })]),
                    });
                }
                if (verdict.kind === 'unidentified') {
                    throw new PluginError({
                        code: 'plugin_exec_system_tool_unidentified',
                        message: `${tool.displayName}: could not identify the runtime at ${verdict.observedPath} through an ACP initialize probe. ${readiness.unidentifiedGuidance}`,
                        diagnostics: projectSystemToolDiagnostics([createUnidentifiedSystemToolDiagnostic({
                            toolId: tool.toolId,
                            displayName: tool.displayName,
                            observedPath: verdict.observedPath,
                            guidance: readiness.unidentifiedGuidance,
                        })]),
                    });
                }
                return null;
            }

            if (tool.readiness) {
                const granted = await resolveWithReadiness(tool.readiness);
                if (granted) return granted;
            }

            for (const candidate of candidates) {
                assertNotAborted(request.signal);
                if (!isAbsolute(candidate)) {
                    continue;
                }
                if (isDeniedPathOnlyRuntimeName(candidate)) {
                    throw createDeniedSystemToolError({
                        definition,
                        executablePath: candidate,
                    });
                }
                assertNotAborted(request.signal);
                const launch = await resolveRunnableLaunch(candidate);
                if (!launch) {
                    continue;
                }
                return issueGrant(candidate, launch);
            }

            assertNotAborted(request.signal);
            const diagnostic = createMissingSystemToolDiagnostic({
                toolId: definition.toolId,
                displayName: definition.displayName,
                executablePath: request.preferredPath ?? definition.executablePath,
                lookupNames: definition.lookupNames,
            });
            throw new PluginError({
                code: 'plugin_exec_system_tool_unavailable',
                message: `System tool '${definition.toolId}' is unavailable. Install it on this Machine and make it executable on the daemon PATH.`,
                details: { ...MISSING_SYSTEM_TOOL_DETAILS, toolId: definition.toolId },
                diagnostics: projectSystemToolDiagnostics([diagnostic]),
            });
        },
    });
}
