import type { SessionProviderTranscriptEventPayloadV1 } from '@happier-dev/protocol';

export type SessionHookProviderPayloadV1 = Readonly<Record<string, unknown>>;

export type SessionHookLifecycleV1 =
    | Readonly<{ kind: 'runner' }>
    | Readonly<{
        kind: 'session';
        sessionId: string;
    }>;

export type SessionHookServerStartRequestV1 = Readonly<{
    providerId: string;
    sessionId: string;
    lifecycle?: SessionHookLifecycleV1;
    onSessionHook?: (providerSessionId: string, data: SessionHookProviderPayloadV1) => void | Promise<void>;
    onPermissionHook?: (data: SessionHookProviderPayloadV1) => unknown | Promise<unknown>;
    /**
     * Statusline payloads pushed by a session-hook forwarder. The host responds before the consumer
     * runs and swallows consumer errors, so statusline processing cannot delay the provider UI.
     */
    onStatuslineUpdate?: (data: SessionHookProviderPayloadV1) => void | Promise<void>;
    defaultPermissionHookResponse?: (data: SessionHookProviderPayloadV1) => unknown;
    sessionHookSecret?: string;
    permissionHookSecret?: string;
    permissionRequestTimeoutMs?: number | null;
    /**
     * Optional per-tool override for the permission-response timeout, resolved by tool name once
     * the hook body is read. Returning `null` means no Happier-imposed timeout; a number sets that
     * timeout; `undefined` falls back to `permissionRequestTimeoutMs`.
     */
    permissionRequestTimeoutMsForTool?: (toolName: string | null) => number | null | undefined;
}>;

export type SessionHookServerHandleV1 = Readonly<{
    port: number;
    sessionHookSecretFile?: string;
    permissionHookSecretFile?: string;
    stop(): void;
    dispose(): Promise<void>;
}>;

export type SessionHookForwarderAssetsV1 = Readonly<{
    nodeExecutable: string;
    sessionForwarderScript: string;
    permissionForwarderScript: string;
    /** Optional so older hosts remain valid; consumers must treat absence as statusline-off. */
    statuslineForwarderScript?: string;
}>;

export type SessionHookPluginFileV1 =
    | Readonly<{
        path: string;
        json: unknown;
        contents?: never;
    }>
    | Readonly<{
        path: string;
        contents: string;
        json?: never;
    }>;

export type SessionHookPluginDirLifecycleV1 = SessionHookLifecycleV1;

export type SessionHookPluginDirCreateRequestV1 = Readonly<{
    providerId: string;
    /**
     * Defaults to a runner-scoped temporary plugin dir. Session lifecycle dirs are stable for the
     * provider/session pair and are retained when the runner disposes them, so resumable providers
     * can keep referring to the same plugin path across process restarts.
     */
    lifecycle?: SessionHookPluginDirLifecycleV1;
    files: readonly SessionHookPluginFileV1[];
}>;

export type SessionProviderTranscriptPublishRequestV1 = SessionProviderTranscriptEventPayloadV1;

export interface SessionHooksRuntimeServiceV1 {
    startServer(request: SessionHookServerStartRequestV1): Promise<SessionHookServerHandleV1>;
    resolveForwarderAssets(): Promise<SessionHookForwarderAssetsV1>;
    createPluginDir(request: SessionHookPluginDirCreateRequestV1): Promise<string>;
    disposePluginDir(pluginDir: string): Promise<void>;
    publishProviderTranscript(request: SessionProviderTranscriptPublishRequestV1): Promise<void>;
}
