import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

export type ActionSpecRpcRegistrationScope = Readonly<{
    id: string;
    methods?: readonly string[];
    methodPrefixes?: readonly string[];
    excludedMethods?: readonly string[];
}>;

export type ActionSpecRpcRegistrationSpec = Readonly<{
    bindings?: Readonly<{ rpcMethod?: string | null; rpcMethodAliases?: readonly string[] }>;
}>;

function normalizeRpcMethod(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function isActionSpecRpcMethodInScope(
    method: string,
    scope: ActionSpecRpcRegistrationScope,
): boolean {
    const normalized = normalizeRpcMethod(method);
    if (!normalized) {
        return false;
    }
    if ((scope.excludedMethods ?? []).some((entry) => normalizeRpcMethod(entry) === normalized)) {
        return false;
    }
    if ((scope.methods ?? []).some((entry) => normalizeRpcMethod(entry) === normalized)) {
        return true;
    }
    return (scope.methodPrefixes ?? []).some((prefix) => {
        const normalizedPrefix = normalizeRpcMethod(prefix);
        return normalizedPrefix.length > 0 && normalized.startsWith(normalizedPrefix);
    });
}

export function isActionSpecRpcSpecInScopes(
    spec: ActionSpecRpcRegistrationSpec,
    scopes: readonly ActionSpecRpcRegistrationScope[],
): boolean {
    const method = normalizeRpcMethod(spec.bindings?.rpcMethod);
    return scopes.some((scope) => isActionSpecRpcMethodInScope(method, scope));
}

export function collectActionSpecRpcMethodsForScopes(
    specs: readonly ActionSpecRpcRegistrationSpec[],
    scopes: readonly ActionSpecRpcRegistrationScope[],
): readonly string[] {
    return specs
        .filter((spec) => isActionSpecRpcSpecInScopes(spec, scopes))
        .flatMap((spec) => [
            normalizeRpcMethod(spec.bindings?.rpcMethod),
            ...(spec.bindings?.rpcMethodAliases ?? []).map(normalizeRpcMethod),
        ])
        .filter(Boolean);
}

export const SUBAGENT_RPC_SCOPES = Object.freeze([
    { id: 'sessions.subagents', methodPrefixes: ['sessions.subagents.'] },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const SESSION_PERMISSION_RPC_SCOPES = Object.freeze([
    {
        id: 'session.permissions',
        methodPrefixes: ['session.permission', 'session.user_action.'],
    },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const APPROVAL_RPC_SCOPES = Object.freeze([
    { id: 'approval.requests', methodPrefixes: ['approval.request.'] },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const PLUGIN_PERMISSION_GRANT_RPC_SCOPES = Object.freeze([
    { id: 'plugins.permissions.grants', methodPrefixes: ['plugins.permissions.grants.'] },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const MACHINE_SESSION_LIFECYCLE_RPC_SCOPES = Object.freeze([
    {
        id: 'machine.session.lifecycle',
        methods: [
            RPC_METHODS.SPAWN_HAPPY_SESSION,
            RPC_METHODS.SESSION_FORK,
            RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY,
        ],
    },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const MACHINE_SESSION_STOP_RPC_SCOPES = Object.freeze([
    { id: 'machine.session.stop', methods: [RPC_METHODS.STOP_SESSION] },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const SESSION_HANDOFF_LIFECYCLE_RPC_SCOPES = Object.freeze([
    { id: 'session.handoff', methodPrefixes: ['daemon.sessionHandoff.'] },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const SESSION_LIFECYCLE_RPC_SCOPES = Object.freeze([
    ...MACHINE_SESSION_LIFECYCLE_RPC_SCOPES,
    ...MACHINE_SESSION_STOP_RPC_SCOPES,
    { id: 'session.rollback', methods: [SESSION_RPC_METHODS.SESSION_ROLLBACK] },
    { id: 'session.checkpoint_code_rollback', methods: [SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK] },
    { id: 'session.checkpoint', methods: [SESSION_RPC_METHODS.SESSION_CHECKPOINT] },
    { id: 'session.restore', methods: [SESSION_RPC_METHODS.SESSION_RESTORE] },
    ...SESSION_HANDOFF_LIFECYCLE_RPC_SCOPES,
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const EXECUTION_RUN_RPC_SCOPES = Object.freeze([
    { id: 'execution.runs', methodPrefixes: ['execution.run.'] },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const REVIEW_COMMENT_RPC_SCOPES = Object.freeze([
    { id: 'reviews.comments', methodPrefixes: ['reviews.comments.'] },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const SESSION_TRANSCRIPT_RPC_SCOPES = Object.freeze([
    {
        id: 'session.transcripts',
        methods: [
            RPC_METHODS.SESSION_LOG_TAIL,
            RPC_METHODS.TRANSCRIPT_PAGE,
            RPC_METHODS.TRANSCRIPT_READ_AFTER,
            RPC_METHODS.TRANSCRIPT_FOLLOW,
            RPC_METHODS.TRANSCRIPT_IMPORT,
            RPC_METHODS.TRANSCRIPT_SEARCH,
        ],
    },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const EXTERNAL_SESSION_REQUIRED_GENERIC_RPC_SCOPES = Object.freeze([
    {
        id: 'sessions.external',
        methods: [
            RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET,
            RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_INSTALL,
            RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_DISABLE,
            RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_ENABLE,
            RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_UNINSTALL,
        ],
        methodPrefixes: ['daemon.externalSessions.'],
    },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const PROMPT_ASSET_RPC_SCOPES = Object.freeze([
    {
        id: 'daemon.admin.promptAssets',
        methods: [
            RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER,
            RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE,
        ],
    },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const PROMPT_REGISTRY_RPC_SCOPES = Object.freeze([
    {
        id: 'daemon.admin.promptRegistry',
        methods: [
            RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE,
            RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL,
        ],
    },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const FILESYSTEM_RPC_SCOPES = Object.freeze([
    {
        id: 'daemon.admin.filesystem',
        methods: [
            RPC_METHODS.READ_FILE,
            RPC_METHODS.WRITE_FILE,
            RPC_METHODS.LIST_DIRECTORY,
            RPC_METHODS.GET_DIRECTORY_TREE,
        ],
    },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const MACHINE_FILE_BROWSER_RPC_SCOPES = Object.freeze([
    {
        id: 'daemon.admin.machineFileBrowser',
        methods: [
            RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS,
            RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
        ],
    },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const BUG_REPORT_RPC_SCOPES = Object.freeze([
    {
        id: 'daemon.admin.bugreport',
        methodPrefixes: ['bugreport.'],
    },
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const DAEMON_ADMIN_RPC_SCOPES = Object.freeze([
    ...PROMPT_ASSET_RPC_SCOPES,
    ...PROMPT_REGISTRY_RPC_SCOPES,
    ...FILESYSTEM_RPC_SCOPES,
    ...MACHINE_FILE_BROWSER_RPC_SCOPES,
    ...BUG_REPORT_RPC_SCOPES,
] satisfies readonly ActionSpecRpcRegistrationScope[]);

export const REQUIRED_GENERIC_ACTION_SPEC_RPC_SCOPES = Object.freeze([
    ...SUBAGENT_RPC_SCOPES,
    ...SESSION_PERMISSION_RPC_SCOPES,
    ...APPROVAL_RPC_SCOPES,
    ...PLUGIN_PERMISSION_GRANT_RPC_SCOPES,
    ...SESSION_LIFECYCLE_RPC_SCOPES,
    ...EXECUTION_RUN_RPC_SCOPES,
    ...REVIEW_COMMENT_RPC_SCOPES,
    ...SESSION_TRANSCRIPT_RPC_SCOPES,
    ...EXTERNAL_SESSION_REQUIRED_GENERIC_RPC_SCOPES,
    ...DAEMON_ADMIN_RPC_SCOPES,
] satisfies readonly ActionSpecRpcRegistrationScope[]);
