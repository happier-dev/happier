import type { AcpBackendAuthConfigV1 } from '@happier-dev/protocol';

import type { AcpCapabilityFlagsV1 } from './acpCapabilities';
import type { AcpTransportSpecV1 } from './acpTransport';
import type { ExtensionContextV1 } from '../context';

export type AcpMcpInputPolicyV1 = Readonly<{
    policy: 'pass_through' | 'drop';
}>;

export type AcpAuthDetectionV1 = 'logged_in' | 'logged_out' | 'unknown';

export type AcpAuthSpecV1 = Readonly<{
    config?: AcpBackendAuthConfigV1;
    detectAuthStatus?: (ctx: ExtensionContextV1) => Promise<AcpAuthDetectionV1>;
    buildAuthEnv?: (ctx: ExtensionContextV1) => Readonly<Record<string, string>>;
}>;

export type AcpTimeoutsV1 = Partial<Readonly<{
    initMs: number;
    initDelayMs: number;
    idleMs: number;
    toolCallMs: number;
    promptLivenessMs: number;
    postPromptNoUpdatesMs: number;
    postToolCallIdleMs: number;
    idleWithoutAssistantMessageMs: number;
    preToolCallIdleMs: number;
}>>;

export type AcpPermissionModeArgvSpecV1 = Readonly<{
    flag: string;
    map: Readonly<Record<string, string | null>>;
}>;

export type AcpBootstrapV1 = Readonly<{
    preStart?: (ctx: ExtensionContextV1) => Promise<void>;
    postReady?: (ctx: ExtensionContextV1) => Promise<void>;
}>;

export type AcpMessageMetaEnrichmentV1 = Readonly<Record<string, unknown>> | null | undefined | void;

export type AcpMessageMetaHooksV1 = Readonly<{
    enrichOutgoing?: (message: unknown, context: unknown) => AcpMessageMetaEnrichmentV1;
    enrichIncoming?: (message: unknown, context: unknown) => AcpMessageMetaEnrichmentV1;
}>;

export type AcpTier2ArgvBuilderV1 = (params: Readonly<{
    cwd: string;
    permissionMode?: string;
}>) => readonly string[] | Promise<readonly string[]>;

export type AcpTier2EnvBuilderV1 = (params: Readonly<{
    cwd: string;
    env: Readonly<Record<string, string>>;
}>) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;

export type AcpTier2PreflightV1 = (params: Readonly<{
    cwd: string;
}>) => void | Promise<void>;

export type AcpTier2PermissionDecisionV1 = (request: unknown) => unknown | Promise<unknown>;

export type AcpTransportLifecycleV1 = Readonly<{
    initDelayMs?: number;
    handshake?: (ctx: ExtensionContextV1) => Promise<void>;
}>;

export type AcpUxSpecV1 = Readonly<{
    name?: string;
    title?: string;
    description?: string;
    defaultMode?: string;
    defaultModel?: string;
}>;

export type AcpBackendSpecV1 = Readonly<{
    backendId: string;
    transport: AcpTransportSpecV1;
    ux?: AcpUxSpecV1;
    launchEnv?: Readonly<Record<string, string>>;
    capabilities?: AcpCapabilityFlagsV1;
    auth?: AcpAuthSpecV1;
    fsEnabled?: boolean;
    transportLifecycle?: AcpTransportLifecycleV1;
    permissionModeArgv?: AcpPermissionModeArgvSpecV1;
    sessionIdHeaderName?: string;
    bootstrap?: AcpBootstrapV1;
    messageMeta?: AcpMessageMetaHooksV1;
    mcp?: AcpMcpInputPolicyV1;
    callbacks?: Readonly<{
        argvBuilder?: AcpTier2ArgvBuilderV1;
        envBuilder?: AcpTier2EnvBuilderV1;
        preflight?: AcpTier2PreflightV1;
        permissionDecision?: AcpTier2PermissionDecisionV1;
    }>;
}>;
