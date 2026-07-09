import type { AcpBackendAuthConfigV1 } from '@happier-dev/protocol';

import type { AcpCapabilityFlagsV1 } from './acpCapabilities.js';
import type { AcpTransportSpecV1 } from './acpTransport.js';
import type { PluginContextV1 } from '../context.js';
import type {
    SessionPermissionFollowUpPromptIntentV1,
    SessionPermissionPersistAllowRuleV1,
} from '../sessions/scoped.js';

export type AcpMcpInputPolicyV1 = Readonly<{
    policy: 'pass_through' | 'drop';
}>;

export type AcpAuthDetectionV1 = 'logged_in' | 'logged_out' | 'unknown';

export type AcpAuthSpecV1 = Readonly<{
    config?: AcpBackendAuthConfigV1;
    methodId?: string;
    resolveMethodId?: (
        ctx: PluginContextV1,
        params: Readonly<{
            cwd: string;
            env: Readonly<Record<string, string>>;
        }>
    ) => string | null | undefined;
    detectAuthStatus?: (ctx: PluginContextV1) => Promise<AcpAuthDetectionV1>;
    buildAuthEnv?: (ctx: PluginContextV1) => Readonly<Record<string, string>>;
    buildAuthenticateMeta?: (ctx: PluginContextV1) => Readonly<Record<string, unknown>> | null | undefined;
}>;

export type AcpTimeoutsV1 = Partial<Readonly<{
    initMs: number;
    initDelayMs: number;
    idleMs: number;
    toolCallMs: number | null;
    investigationToolCallMs: number | null;
    toolKindTimeouts: Readonly<Record<string, number | null>>;
    promptLivenessMs: number | null;
    postPromptNoUpdatesMs: number | null;
    postToolCallIdleMs: number;
    idleWithoutAssistantMessageMs: number;
    preToolCallIdleMs: number;
}>>;

export type AcpPermissionModeArgvSpecV1 = Readonly<{
    flag: string;
    map: Readonly<Record<string, string | null>>;
}>;

export type AcpBootstrapV1 = Readonly<{
    preStart?: (ctx: PluginContextV1) => Promise<void>;
    postReady?: (ctx: PluginContextV1) => Promise<void>;
}>;

export type AcpMessageMetaEnrichmentV1 = Readonly<Record<string, unknown>> | null | undefined | void;

export type AcpMessageMetaHooksV1 = Readonly<{
    enrichOutgoing?: (message: unknown, context: unknown) => AcpMessageMetaEnrichmentV1;
    enrichIncoming?: (message: unknown, context: unknown) => AcpMessageMetaEnrichmentV1;
}>;

export type AcpTier2ArgvBuilderV1 = (params: Readonly<{
    baseArgs: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    permissionMode?: string;
}>) => readonly string[] | Promise<readonly string[]>;

export type AcpTier2EnvBuilderV1 = (params: Readonly<{
    cwd: string;
    env: Readonly<Record<string, string>>;
    permissionMode?: string;
}>) => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;

export type AcpPermissionOptionSelectionV1 = Readonly<{
    approved?: 'allow_once' | 'allow_always';
}>;

export type AcpTier2PreflightV1 = (params: Readonly<{
    cwd: string;
}>) => void | Promise<void>;

export type AcpTier2PermissionDecisionResultV1 = Readonly<{
    kind: 'allow' | 'deny' | 'defer';
    rationale?: string;
    followUpPrompt?: SessionPermissionFollowUpPromptIntentV1;
    persistAllowRule?: SessionPermissionPersistAllowRuleV1;
}>;

export type AcpTier2PermissionDecisionRequestV1 = Readonly<{
    toolCallId: string;
    toolName: string;
    input: unknown;
}>;

export type AcpTier2PermissionDecisionV1 = (
    request: AcpTier2PermissionDecisionRequestV1
) => AcpTier2PermissionDecisionResultV1 | Promise<AcpTier2PermissionDecisionResultV1>;

export type AcpToolNameResolverV1 = (
    request: Readonly<{
        toolName: string;
        toolCallId: string;
        input: Readonly<Record<string, unknown>>;
        context: Readonly<{
            toolCallCountSincePrompt: number;
        }>;
    }>
) => string | null | undefined;

export type AcpToolNamePatternV1 = Readonly<{
    name: string;
    patterns: readonly string[];
    inputFields?: readonly string[];
    emptyInputDefault?: boolean;
}>;

export type AcpToolNameInferenceV1 = Readonly<{
    patterns?: readonly AcpToolNamePatternV1[];
    preferLongestPattern?: boolean;
    unknownToolNames?: readonly string[];
    hintInputFields?: readonly string[];
    shellBridgeHint?: boolean;
    investigationToolIdPatterns?: readonly string[];
    investigationToolKinds?: readonly string[];
}>;

export type AcpStderrMatchRuleV1 = Readonly<{
    includes: readonly string[];
    caseSensitive?: boolean;
}>;

export type AcpStderrStatusErrorRuleV1 = AcpStderrMatchRuleV1 & Readonly<{
    detail: string;
}>;

export type AcpStderrRulesV1 = Readonly<{
    suppress?: readonly AcpStderrMatchRuleV1[];
    statusErrors?: readonly AcpStderrStatusErrorRuleV1[];
}>;

export type AcpTransportLifecycleV1 = Readonly<{
    initDelayMs?: number;
    handshake?: (ctx: PluginContextV1) => Promise<void>;
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
    toolNameInference?: AcpToolNameInferenceV1;
    stderrRules?: AcpStderrRulesV1;
    permissionOptionSelection?: AcpPermissionOptionSelectionV1;
    bootstrap?: AcpBootstrapV1;
    messageMeta?: AcpMessageMetaHooksV1;
    mcp?: AcpMcpInputPolicyV1;
    callbacks?: Readonly<{
        argvBuilder?: AcpTier2ArgvBuilderV1;
        envBuilder?: AcpTier2EnvBuilderV1;
        preflight?: AcpTier2PreflightV1;
        permissionDecision?: AcpTier2PermissionDecisionV1;
        toolNameResolver?: AcpToolNameResolverV1;
    }>;
}>;
