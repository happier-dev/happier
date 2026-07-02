import type { SessionProviderTranscriptEventPayloadV1 } from '@happier-dev/protocol';

export type SessionHookProviderPayloadV1 = Readonly<Record<string, unknown>>;

export type SessionHookServerStartRequestV1 = Readonly<{
    providerId: string;
    sessionId: string;
    onSessionHook?: (providerSessionId: string, data: SessionHookProviderPayloadV1) => void | Promise<void>;
    onPermissionHook?: (data: SessionHookProviderPayloadV1) => unknown | Promise<unknown>;
    /**
     * Claude statusline payloads pushed by the statusline forwarder wrapper (`/hook/statusline`,
     * authenticated with the session hook secret). The host responds before the consumer runs and
     * swallows consumer errors — statusline processing must never delay the provider's status bar.
     */
    onStatuslineUpdate?: (data: SessionHookProviderPayloadV1) => void | Promise<void>;
    defaultPermissionHookResponse?: (data: SessionHookProviderPayloadV1) => unknown;
    sessionHookSecret?: string;
    permissionHookSecret?: string;
    permissionRequestTimeoutMs?: number | null;
    /**
     * Optional per-tool override for the permission-response timeout, resolved by tool name once
     * the hook body is read. Returning `null` means no Happier-imposed timeout (bounded only by
     * Claude's provider hook timeout) — used for interactive tools (AskUserQuestion/ExitPlanMode);
     * a number sets that timeout; `undefined` falls back to `permissionRequestTimeoutMs`.
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

export type SessionHookPluginDirCreateRequestV1 = Readonly<{
    providerId: string;
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
