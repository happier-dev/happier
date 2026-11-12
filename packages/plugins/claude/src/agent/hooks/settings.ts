import { buildShellCommand } from '@happier-dev/plugin-sdk/agents/runtime';
import { listHappierToolAutoApprovedNameSpellingsV1 } from '@happier-dev/plugin-sdk/agents/runtime';

import { resolveClaudePermissionHookTimeoutSeconds } from './permissionHookTimeout.js';

export type ClaudeSessionHookEventName =
    | 'SessionStart'
    | 'UserPromptSubmit'
    | 'Stop'
    | 'StopFailure'
    | 'SessionEnd'
    | 'PostToolUse'
    | 'SubagentStart'
    | 'SubagentStop';

export type ClaudePermissionHookEventName = 'PermissionRequest' | 'PreToolUse';

export type ClaudeHookCommand = Readonly<{
    type: 'command';
    command: string;
    /**
     * Seconds Claude waits for this hook's forwarder before killing it. Installed only on the
     * permission hooks (PermissionRequest / AskUserQuestion PreToolUse) and defaulted to an
     * effectively-unlimited 7 days so a permission can be answered overnight; omitted for
     * lifecycle hooks, which keep Claude's own default.
     */
    timeout?: number;
}>;

export type ClaudeHookEntry = Readonly<{
    matcher: string;
    hooks: readonly ClaudeHookCommand[];
}>;

export type ClaudeHookPluginHooks = Readonly<{
    hooks: Readonly<Record<string, readonly ClaudeHookEntry[]>>;
}>;

export type ClaudeHookSettingsOverlay = Readonly<{
    permissions?: Readonly<{
        allow?: readonly string[];
    }>;
    hooks?: never;
}>;

export type ClaudeHookPluginManifest = Readonly<{
    name: string;
    version: string;
    description: string;
    author: Readonly<{
        name: string;
    }>;
}>;

export type BuildClaudeHookPluginHooksParams = Readonly<{
    /** SDK lifecycle hooks use stdio after startup; SessionStart precedes initialization. */
    transport?: 'sdk' | 'terminal';
    port: number;
    platform?: NodeJS.Platform;
    nodeExecutable: string;
    sessionForwarderScript: string;
    sessionHookSecretFile?: string;
    permissionForwarderScript?: string;
    enableLocalPermissionBridge?: boolean;
    /** The admitted host requires a Home witness before the accepted prompt generates. */
    awaitTurnPublication?: boolean;
    /** Observe exact native tool-use identities through the authenticated session endpoint. */
    observeNativeToolPrompts?: boolean;
    unlistedTools?: 'ask' | 'deny';
    permissionHookSecretFile?: string;
    /**
     * Effective timeout (seconds) Claude enforces on the permission-hook forwarder. Defaults to
     * an effectively-unlimited 7 days (env-overridable via the shared resolver) so a permission
     * can be answered overnight. Must stay aligned with the host hook-server response ceiling.
     */
    permissionHookTimeoutSeconds?: number;
}>;

export type BuildClaudeHookPluginManifestParams = Readonly<{
    instanceId: string;
}>;

const CLAUDE_SESSION_HOOK_EVENTS: readonly ClaudeSessionHookEventName[] = [
    'SessionStart',
    'UserPromptSubmit',
    'Stop',
    'StopFailure',
    'SessionEnd',
    'PostToolUse',
    'SubagentStart',
    'SubagentStop',
];

export const CLAUDE_SDK_SESSION_HOOK_CALLBACK_ID = 'happier-session-hook';

export function buildClaudeSdkSessionHooks(): Readonly<Record<string, readonly Readonly<{ hookCallbackIds: readonly string[] }>[]>> {
    return Object.fromEntries(CLAUDE_SESSION_HOOK_EVENTS.filter(eventName => eventName !== 'SessionStart').map(eventName => [eventName, [{
        hookCallbackIds: [CLAUDE_SDK_SESSION_HOOK_CALLBACK_ID],
    }]]));
}

export function buildClaudeHookSettingsOverlay(): ClaudeHookSettingsOverlay {
    return {
        permissions: {
            allow: listHappierToolAutoApprovedNameSpellingsV1('mcp__happier__'),
        },
    };
}

export function buildClaudeHookPluginManifest(params: BuildClaudeHookPluginManifestParams): ClaudeHookPluginManifest {
    return {
        name: `happier-session-hooks-${params.instanceId}`,
        version: '1.0.0',
        description: 'Happier session-scoped Claude Code hooks.',
        author: { name: 'Happier' },
    };
}

export function buildClaudeHookPluginHooks(params: BuildClaudeHookPluginHooksParams): ClaudeHookPluginHooks {
    const hooks: Record<string, readonly ClaudeHookEntry[]> = {};
    const permissionHookTimeoutSeconds = resolveClaudePermissionHookTimeoutSeconds({
        ...(params.permissionHookTimeoutSeconds !== undefined
            ? { explicitSeconds: params.permissionHookTimeoutSeconds }
            : {}),
        env: process.env,
    });
    // Claude emits startup before the initialize request can register SDK callbacks.
    // Keep this fact on the authenticated command carrier, with no duplicate SDK owner.
    for (const eventName of params.transport === 'sdk' ? ['SessionStart'] as const : CLAUDE_SESSION_HOOK_EVENTS) {
        hooks[eventName] = [buildCommandHook({
            command: buildForwarderCommand({
                platform: params.platform,
                nodeExecutable: params.nodeExecutable,
                scriptPath: params.sessionForwarderScript,
                port: params.port,
                hookEventName: eventName,
                secretFile: params.sessionHookSecretFile,
            }),
            matcher: '',
        })];
    }

    if (params.awaitTurnPublication === true) {
        if (!params.permissionForwarderScript) throw new TypeError('permissionForwarderScript is required for accepted Turn publication');
        hooks.UserPromptSubmit = [buildCommandHook({ matcher: '', timeout: permissionHookTimeoutSeconds, command: buildForwarderCommand({
            platform: params.platform, nodeExecutable: params.nodeExecutable,
            scriptPath: params.permissionForwarderScript, port: params.port,
            hookEventName: 'UserPromptSubmit', secretFile: params.permissionHookSecretFile,
            denyOnUnavailable: true,
        }) })];
    }

    if (params.enableLocalPermissionBridge === true) {
        if (typeof params.permissionForwarderScript !== 'string' || params.permissionForwarderScript.length === 0) {
            throw new TypeError('permissionForwarderScript is required when the Claude local permission bridge is enabled');
        }

        hooks.PermissionRequest = [buildCommandHook({
            command: buildForwarderCommand({
                platform: params.platform,
                nodeExecutable: params.nodeExecutable,
                scriptPath: params.permissionForwarderScript,
                port: params.port,
                hookEventName: 'PermissionRequest',
                secretFile: params.permissionHookSecretFile,
                denyOnUnavailable: params.unlistedTools === 'deny',
            }),
            matcher: '*',
            timeout: permissionHookTimeoutSeconds,
        })];
        hooks.PreToolUse = [buildCommandHook({
            command: buildForwarderCommand({
                platform: params.platform,
                nodeExecutable: params.nodeExecutable,
                scriptPath: params.permissionForwarderScript,
                port: params.port,
                hookEventName: 'PreToolUse',
                secretFile: params.permissionHookSecretFile,
                denyOnUnavailable: params.unlistedTools === 'deny',
            }),
            // Native safe reads bypass PermissionRequest and SDK canUseTool.
            // The existing host permission owner must see every confined call first.
            matcher: params.unlistedTools === 'deny' ? '*' : 'AskUserQuestion',
            timeout: permissionHookTimeoutSeconds,
        })];
    }

    if (params.observeNativeToolPrompts === true) {
        hooks.PreToolUse = [...(hooks.PreToolUse ?? []), buildCommandHook({
            command: buildForwarderCommand({
                platform: params.platform,
                nodeExecutable: params.nodeExecutable,
                scriptPath: params.sessionForwarderScript,
                port: params.port,
                hookEventName: 'PreToolUse',
                secretFile: params.sessionHookSecretFile,
            }),
            matcher: '*',
        })];
    }

    return { hooks };
}

function buildCommandHook(params: Readonly<{
    command: string;
    matcher: string;
    timeout?: number;
}>): ClaudeHookEntry {
    return {
        matcher: params.matcher,
        hooks: [
            {
                type: 'command',
                command: params.command,
                ...(params.timeout !== undefined ? { timeout: params.timeout } : {}),
            },
        ],
    };
}

function buildForwarderCommand(params: Readonly<{
    platform?: NodeJS.Platform;
    nodeExecutable: string;
    scriptPath: string;
    port: number;
    hookEventName: ClaudeSessionHookEventName | ClaudePermissionHookEventName;
    secretFile?: string;
    denyOnUnavailable?: boolean;
}>): string {
    const parts = [
        params.nodeExecutable,
        params.scriptPath,
        String(params.port),
        params.hookEventName,
    ];
    if (typeof params.secretFile === 'string' && params.secretFile.length > 0) {
        parts.push('--secret-file', params.secretFile);
    }
    if (params.denyOnUnavailable) parts.push('--deny-on-unavailable');
    if ((params.platform ?? process.platform) === 'win32') {
        return buildShellCommand(parts, 'powershell_encoded');
    }
    return buildShellCommand(parts, 'posix');
}
