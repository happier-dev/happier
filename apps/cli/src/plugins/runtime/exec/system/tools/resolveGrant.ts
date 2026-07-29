import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, delimiter, isAbsolute, join } from 'node:path';

import type {
    SystemToolDiagnosticV1,
    SystemToolLaunchGrantV1,
    SystemToolResolveRequestV1,
    SystemToolSourceV1,
} from '../../privateContract';
import {
    agentCliPathRequiresJavaScriptRuntime,
    resolveAgentCliJavaScriptRuntimeCommand,
} from '@happier-dev/cli-common/agents';

import {
    isPluginExecSystemToolSupportedOnHost,
    type PluginExecSystemToolDefinition,
    type PluginExecSystemToolGrantRecord,
} from './definitions';
import {
    createMissingSystemToolDiagnostic,
    createSystemToolDiagnostic,
} from './diagnostics';
import { isDeniedPathOnlyRuntimeName, normalizePathOnlyRuntimeName } from './runtimeDeny';

export type PluginExecSystemToolErrorCode =
    | 'PLUGIN_EXEC_SYSTEM_TOOL_ABORTED'
    | 'PLUGIN_EXEC_SYSTEM_TOOL_DENIED'
    | 'PLUGIN_EXEC_SYSTEM_TOOL_UNDECLARED'
    | 'PLUGIN_EXEC_SYSTEM_TOOL_UNAVAILABLE'
    | 'PLUGIN_EXEC_SYSTEM_TOOL_INVALID_PATH'
    | 'PLUGIN_EXEC_SYSTEM_TOOL_INVALID_COMMAND'
    | 'PLUGIN_EXEC_SYSTEM_TOOL_PLATFORM_UNSUPPORTED';

export class PluginExecSystemToolError extends Error {
    readonly code: PluginExecSystemToolErrorCode;
    readonly diagnostics: readonly SystemToolDiagnosticV1[];

    constructor(
        code: PluginExecSystemToolErrorCode,
        message: string,
        diagnostics: readonly SystemToolDiagnosticV1[] = [],
    ) {
        super(message);
        this.name = 'PluginExecSystemToolError';
        this.code = code;
        this.diagnostics = diagnostics;
    }
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
}>;

function createAbortError(): PluginExecSystemToolError {
    return new PluginExecSystemToolError(
        'PLUGIN_EXEC_SYSTEM_TOOL_ABORTED',
        'System tool resolution was aborted',
        [createSystemToolDiagnostic({
            code: 'system_tool_aborted',
            severity: 'warning',
            messageKey: 'plugins.exec.systemTools.aborted',
        })],
    );
}

function createDeniedSystemToolError(params: Readonly<{
    definition: PluginExecSystemToolDefinition;
    executablePath: string;
}>): PluginExecSystemToolError {
    const executableName = basename(params.executablePath);
    return new PluginExecSystemToolError(
        'PLUGIN_EXEC_SYSTEM_TOOL_DENIED',
        `System tool '${params.definition.displayName}' resolves to a managed runtime/package-manager executable`,
        [createSystemToolDiagnostic({
            code: 'system_tool_denied',
            severity: 'error',
            messageKey: 'plugins.exec.systemTools.denied',
            detail: {
                toolId: params.definition.toolId,
                displayName: params.definition.displayName,
                executableName,
                normalizedName: normalizePathOnlyRuntimeName(executableName),
            },
        })],
    );
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
): readonly string[] {
    const candidates: string[] = [];
    const pushCandidate = (candidate: string) => {
        if (!candidates.includes(candidate)) {
            candidates.push(candidate);
        }
    };
    const pushLookupName = (lookupName: string) => {
        if (isAbsolute(lookupName)) {
            pushCandidate(lookupName);
            return;
        }
        const searchPath = env.PATH ?? '';
        const searchRoots = searchPath.split(delimiter).filter((entry) => entry.length > 0);
        for (const root of searchRoots) {
            pushCandidate(join(root, lookupName));
        }
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

function buildSystemToolLookupEnv(baseEnv: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
    return Object.freeze({
        PATH: baseEnv?.PATH ?? process.env.PATH ?? '',
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
        throw new PluginExecSystemToolError(
            'PLUGIN_EXEC_SYSTEM_TOOL_INVALID_COMMAND',
            `System tool '${request.toolId}' preferred command must be a declared lookup name`,
            [createSystemToolDiagnostic({
                code: 'system_tool_invalid_command',
                severity: 'error',
                messageKey: 'plugins.exec.systemTools.invalidCommand',
                detail: {
                    toolId: request.toolId,
                    displayName: definition.displayName,
                    preferredCommand,
                },
            })],
        );
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
                throw new PluginExecSystemToolError(
                    'PLUGIN_EXEC_SYSTEM_TOOL_UNDECLARED',
                    `System tool '${request.toolId}' is not declared for this plugin runtime`,
                    [createSystemToolDiagnostic({
                        code: 'system_tool_undeclared',
                        severity: 'error',
                        messageKey: 'plugins.exec.systemTools.undeclared',
                        detail: { toolId: request.toolId },
                    })],
                );
            }
            if (!isPluginExecSystemToolSupportedOnHost(definition, process.platform)) {
                throw new PluginExecSystemToolError(
                    'PLUGIN_EXEC_SYSTEM_TOOL_PLATFORM_UNSUPPORTED',
                    `System tool '${definition.displayName}' is not supported on this host platform`,
                    [createSystemToolDiagnostic({
                        code: 'system_tool_platform_unsupported',
                        severity: 'error',
                        messageKey: 'plugins.exec.systemTools.platformUnsupported',
                        detail: {
                            toolId: request.toolId,
                            displayName: definition.displayName,
                            platform: process.platform,
                        },
                    })],
                );
            }

            const env = buildSystemToolLookupEnv(params.baseEnv);
            const invalidPreferredPath = typeof request.preferredPath === 'string'
                && request.preferredPath.trim().length > 0
                && !isAbsolute(request.preferredPath.trim());
            if (invalidPreferredPath) {
                throw new PluginExecSystemToolError(
                    'PLUGIN_EXEC_SYSTEM_TOOL_INVALID_PATH',
                    `System tool '${request.toolId}' preferred path must be absolute`,
                    [createSystemToolDiagnostic({
                        code: 'system_tool_invalid_path',
                        severity: 'error',
                        messageKey: 'plugins.exec.systemTools.invalidPath',
                        detail: {
                            toolId: request.toolId,
                            displayName: definition.displayName,
                            preferredPath: request.preferredPath,
                        },
                    })],
                );
            }
            validatePreferredCommand(definition, request);
            const candidates = normalizeLookupCandidates(definition, request, env);

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
                const isCanonicalReadableJavaScriptPath = (
                    params.preferredPathAccess === 'readable-javascript'
                    && request.preferredPath?.trim() === candidate
                    && await isReadableJavaScriptFile(candidate)
                );
                if (await isExecutableFile(candidate) || isCanonicalReadableJavaScriptPath) {
                    assertNotAborted(request.signal);
                    const launch = isCanonicalReadableJavaScriptPath
                        ? resolveCanonicalAgentCliJavaScriptLaunch(
                            candidate,
                            definition.defaultArgs,
                            params.baseEnv,
                        )
                        : Object.freeze({
                            executablePath: candidate,
                            args: Object.freeze([...(definition.defaultArgs ?? [])]),
                        });
                    if (!launch) continue;
                    const issuedAt = params.now?.() ?? Date.now();
                    const expiresAt = definition.expiresInMs === undefined || definition.expiresInMs === null
                        ? null
                        : issuedAt + Math.max(0, definition.expiresInMs);
                    const grant: PluginExecSystemToolGrantRecord = Object.freeze({
                        kind: 'system-tool',
                        grantId: createGrantId({
                            toolId: definition.toolId,
                            executablePath: launch.executablePath,
                            issuedAt,
                        }),
                        toolId: definition.toolId,
                        executablePath: launch.executablePath,
                        expiresAt,
                    });
                    params.registerGrant(grant);
                    return Object.freeze({
                        grantId: grant.grantId,
                        toolId: definition.toolId,
                        displayName: definition.displayName,
                        source: classifySource(definition, request, candidate),
                        executablePath: candidate,
                        launch: Object.freeze({
                            kind: 'binary',
                            executablePath: launch.executablePath,
                            cwd: request.cwd,
                            args: launch.args,
                            env: Object.freeze({
                                PATH: '',
                                ...(definition.env ?? {}),
                            }),
                        }),
                        ...(definition.allowedArguments ? {
                            allowedArguments: Object.freeze([...definition.allowedArguments]),
                        } : {}),
                        expiresAt,
                    });
                }
            }

            assertNotAborted(request.signal);
            const diagnostic = createMissingSystemToolDiagnostic({
                toolId: definition.toolId,
                displayName: definition.displayName,
                executablePath: request.preferredPath ?? definition.executablePath,
                lookupNames: definition.lookupNames,
            });
            throw new PluginExecSystemToolError(
                'PLUGIN_EXEC_SYSTEM_TOOL_UNAVAILABLE',
                `System tool '${definition.displayName}' is not available`,
                [diagnostic],
            );
        },
    });
}
