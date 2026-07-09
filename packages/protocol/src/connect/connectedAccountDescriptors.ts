import { z } from 'zod';

import { PluginDescriptorBaseV1Schema } from '../plugins/contributions/_descriptors.js';
import {
    ConnectedServiceCredentialKindSchema,
    ConnectedServiceIdSchema,
    type ConnectedServiceCredentialKind,
    type ConnectedServiceId,
} from './connectedServiceSchemas.js';

export const ConnectedAccountTokenKindSchema = z.enum(['api-key', 'setup-token', 'personal-access-token', 'api-token']);
export type ConnectedAccountTokenKind = z.infer<typeof ConnectedAccountTokenKindSchema>;

export const ConnectedAccountConnectModeKindSchema = z.enum(['oauth', 'api-key', 'setup-token', 'token']);
export type ConnectedAccountConnectModeKind = z.infer<typeof ConnectedAccountConnectModeKindSchema>;

export const ConnectedAccountOauthAddActionModeSchema = z.enum(['device', 'paste', 'browser']);
export type ConnectedAccountOauthAddActionMode = z.infer<typeof ConnectedAccountOauthAddActionModeSchema>;

export const ConnectedAccountOauthRefreshBodySchema = z.enum(['form', 'json']);
export type ConnectedAccountOauthRefreshBody = z.infer<typeof ConnectedAccountOauthRefreshBodySchema>;

const EnvBackedPublicValueSchema = z.object({
    envKey: z.string().trim().min(1),
    defaultValue: z.string().trim().min(1),
}).strict();

const HostResolvedConfidentialValueSchema = z.object({
    envKey: z.string().trim().min(1),
    hostDefaultResolverKey: z.string().trim().min(1),
}).strict();

const ConnectedAccountOauthAuthorizationSchema = z.object({
    endpointUrl: z.string().url(),
    defaultRedirectUri: z.string().trim().min(1),
    scopes: z.array(z.string().trim().min(1)).default([]),
    pkce: z.boolean().default(true),
    query: z.object({
        responseType: z.string().trim().min(1),
        accessType: z.string().trim().min(1).optional(),
        prompt: z.string().trim().min(1).optional(),
        extraParams: z.record(z.string(), z.string()).default({}),
    }).strict(),
}).strict();

const ConnectedAccountOauthRefreshSchema = z.object({
    body: ConnectedAccountOauthRefreshBodySchema,
    hookKey: z.string().trim().min(1),
}).strict();

const ConnectedAccountPayloadFieldSchema = z.object({
    field: z.string().trim().min(1),
    objectField: z.string().trim().min(1).optional(),
}).strict();

const ConnectedAccountOauthPayloadMappingSchema = z.object({
    accessTokenField: z.string().trim().min(1),
    refreshTokenField: z.string().trim().min(1),
    idTokenField: z.string().trim().min(1).optional(),
    scopeField: z.string().trim().min(1).optional(),
    tokenTypeField: z.string().trim().min(1).optional(),
    providerAccountIdField: z.union([z.string().trim().min(1), ConnectedAccountPayloadFieldSchema]).optional(),
    providerEmailField: z.union([z.string().trim().min(1), ConnectedAccountPayloadFieldSchema]).optional(),
    expiresAt: z.object({
        absoluteField: z.string().trim().min(1).optional(),
        expiresInField: z.string().trim().min(1).optional(),
    }).strict().default({}),
}).strict();

const ConnectedAccountOAuthDescriptorSchema = z.object({
    publicClientId: EnvBackedPublicValueSchema,
    tokenUrl: EnvBackedPublicValueSchema,
    confidentialClient: HostResolvedConfidentialValueSchema.optional(),
    authorization: ConnectedAccountOauthAuthorizationSchema,
    refresh: ConnectedAccountOauthRefreshSchema,
    payloadMapping: ConnectedAccountOauthPayloadMappingSchema,
}).strict();

const ConnectedAccountTokenSetupDescriptorSchema = z.object({
    tokenKind: ConnectedAccountTokenKindSchema,
    promptLabelKey: z.string().trim().min(1),
    missingValueErrorKey: z.string().trim().min(1),
    setupUrl: z.string().url().optional(),
    permissions: z.record(z.string().trim().min(1), z.string().trim().min(1)).optional(),
    credentialPayloadKind: z.string().trim().min(1).optional(),
    identity: z.object({
        kind: z.enum(['email_or_username']),
        promptLabelKey: z.string().trim().min(1),
        missingValueErrorKey: z.string().trim().min(1),
    }).strict().optional(),
}).passthrough();

export const ConnectedAccountConnectModeDescriptorSchema = z.object({
    targetId: z.string().trim().min(1),
    mode: ConnectedAccountConnectModeKindSchema,
    credentialKind: ConnectedServiceCredentialKindSchema,
    default: z.boolean().default(false),
    tokenKind: ConnectedAccountTokenKindSchema.optional(),
}).strict();

export type ConnectedAccountConnectModeDescriptor = z.infer<typeof ConnectedAccountConnectModeDescriptorSchema>;

const ConnectedAccountUiProjectionDescriptorSchema = z.object({
    connectCommand: z.string().trim().min(1),
    oauthPasteCopyKeyPrefix: z.string().trim().min(1).optional(),
    oauthAddActionModes: z.array(ConnectedAccountOauthAddActionModeSchema).default([]),
    /**
     * Short, brand-only name for compact surfaces (auth chips, account-switch transcript rows),
     * so they read "Codex" / "Claude" instead of the longer localized service titles. Brand proper
     * nouns are identical across locales, so this is intentionally not a translation key. Consumers
     * must fall back to the localized display name when absent.
     */
    shortName: z.string().trim().min(1).optional(),
}).strict();

const ConnectedAccountMaterializationDescriptorSchema = z.object({
    materializationKinds: z.array(z.string().trim().min(1)).default([]),
    hookKey: z.string().trim().min(1).optional(),
}).strict().default({ materializationKinds: [] });

const ConnectedAccountQuotaDescriptorSchema = z.object({
    capabilityIds: z.array(z.string().trim().min(1)).default([]),
    hookKey: z.string().trim().min(1).optional(),
}).strict().default({ capabilityIds: [] });

const ConnectedAccountDescriptorFields = {
    kind: z.literal('auth.connectedAccount'),
    displayKey: z.string().trim().min(1),
    aliases: z.array(z.string().trim().min(1)).default([]),
    credentialKinds: z.array(ConnectedServiceCredentialKindSchema).min(1),
    defaultCredentialKind: ConnectedServiceCredentialKindSchema,
    connectModes: z.array(ConnectedAccountConnectModeDescriptorSchema).default([]),
    oauth: ConnectedAccountOAuthDescriptorSchema.optional(),
    tokenSetup: ConnectedAccountTokenSetupDescriptorSchema.optional(),
    ui: ConnectedAccountUiProjectionDescriptorSchema,
    materialization: ConnectedAccountMaterializationDescriptorSchema,
    quota: ConnectedAccountQuotaDescriptorSchema,
} as const;

function refineConnectedAccountDescriptor(value: Readonly<{
    credentialKinds: readonly ConnectedServiceCredentialKind[];
    defaultCredentialKind: ConnectedServiceCredentialKind;
    oauth?: unknown;
    tokenSetup?: Readonly<{ tokenKind: ConnectedAccountTokenKind }>;
    connectModes: readonly ConnectedAccountConnectModeDescriptor[];
}>, ctx: z.RefinementCtx): void {
    if (value.credentialKinds.includes('oauth') && !value.oauth) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['oauth'],
            message: 'OAuth metadata is required when oauth credentials are supported.',
        });
    }
    if (value.credentialKinds.includes('token') && !value.tokenSetup) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tokenSetup'],
            message: 'Token setup metadata is required when token credentials are supported.',
        });
    }
    if (!value.credentialKinds.includes(value.defaultCredentialKind)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['defaultCredentialKind'],
            message: 'Default credential kind must be one of the supported credential kinds.',
        });
    }
    for (const [index, mode] of value.connectModes.entries()) {
        if (mode.credentialKind === 'oauth' && !value.oauth) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['connectModes', index, 'credentialKind'],
                message: 'OAuth connect modes require OAuth metadata.',
            });
        }
        if (mode.credentialKind === 'token' && mode.tokenKind !== value.tokenSetup?.tokenKind) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['connectModes', index, 'tokenKind'],
                message: 'Token connect modes must match token setup metadata.',
            });
        }
    }
}

export const ConnectedAccountDescriptorSchema = PluginDescriptorBaseV1Schema.safeExtend({
    id: ConnectedServiceIdSchema,
    ...ConnectedAccountDescriptorFields,
}).strict().superRefine(refineConnectedAccountDescriptor);

export const PluginConnectedAccountDescriptorSchema = PluginDescriptorBaseV1Schema.safeExtend({
    id: z.string().trim().min(1),
    ...ConnectedAccountDescriptorFields,
}).strict().superRefine(refineConnectedAccountDescriptor);

export type ConnectedAccountDescriptor = z.infer<typeof ConnectedAccountDescriptorSchema>;
type ConnectedAccountDescriptorInput = z.input<typeof ConnectedAccountDescriptorSchema>;

export function defineConnectedAccountDescriptor(value: ConnectedAccountDescriptorInput): ConnectedAccountDescriptor {
    return ConnectedAccountDescriptorSchema.parse(value);
}

export function buildGithubPersonalAccessTokenUrl(): string {
    const url = new URL('https://github.com/settings/personal-access-tokens/new');
    url.searchParams.set('name', 'Happier SCM');
    url.searchParams.set('description', 'Token for Happier source-control workflows');
    url.searchParams.set('expires_in', '90');
    url.searchParams.set('contents', 'write');
    url.searchParams.set('pull_requests', 'write');
    url.searchParams.set('administration', 'write');
    return url.toString();
}

export const CONNECTED_ACCOUNT_DESCRIPTORS = Object.freeze([
    defineConnectedAccountDescriptor({
        id: 'openai-codex',
        kind: 'auth.connectedAccount',
        version: '1',
        displayKey: 'connectedServices.serviceNames.openaiCodex',
        aliases: ['codex'],
        credentialKinds: ['oauth'],
        defaultCredentialKind: 'oauth',
        connectModes: [
            { targetId: 'codex', mode: 'oauth', credentialKind: 'oauth', default: true },
        ],
        oauth: {
            publicClientId: {
                envKey: 'HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID',
                defaultValue: 'app_EMoamEEZ73f0CkXaXp7hrann',
            },
            tokenUrl: {
                envKey: 'HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL',
                defaultValue: 'https://auth.openai.com/oauth/token',
            },
            authorization: {
                endpointUrl: 'https://auth.openai.com/oauth/authorize',
                defaultRedirectUri: 'http://localhost:1455/auth/callback',
                scopes: ['openid', 'profile', 'email', 'offline_access'],
                pkce: true,
                query: {
                    responseType: 'code',
                    extraParams: {
                        id_token_add_organizations: 'true',
                        codex_cli_simplified_flow: 'true',
                    },
                },
            },
            refresh: { body: 'form', hookKey: 'standard-oauth-refresh' },
            payloadMapping: {
                accessTokenField: 'access_token',
                refreshTokenField: 'refresh_token',
                idTokenField: 'id_token',
                providerAccountIdField: 'account_id',
                expiresAt: { absoluteField: 'expires_at', expiresInField: 'expires_in' },
            },
        },
        ui: {
            connectCommand: 'happier connect codex',
            oauthAddActionModes: ['device', 'paste', 'browser'],
            shortName: 'Codex',
        },
        materialization: {
            materializationKinds: ['agent_runtime_env'],
            hookKey: 'connectedServices.materialization.openaiCodex',
        },
        quota: {
            capabilityIds: ['connectedServices.quotas.openaiCodex'],
            hookKey: 'connectedServices.quotas.openaiCodex',
        },
    }),
    defineConnectedAccountDescriptor({
        id: 'openai',
        kind: 'auth.connectedAccount',
        version: '1',
        displayKey: 'connectedServices.serviceNames.openai',
        aliases: ['codex'],
        credentialKinds: ['token'],
        defaultCredentialKind: 'token',
        connectModes: [
            { targetId: 'codex', mode: 'api-key', credentialKind: 'token', default: false, tokenKind: 'api-key' },
        ],
        tokenSetup: {
            tokenKind: 'api-key',
            promptLabelKey: 'connectedServices.tokenPrompts.openaiApiKey',
            missingValueErrorKey: 'connectedServices.tokenPrompts.errors.missingApiKey',
        },
        ui: {
            connectCommand: 'happier connect codex --api-key',
            oauthAddActionModes: [],
            shortName: 'OpenAI',
        },
        materialization: {
            materializationKinds: ['agent_runtime_env'],
            hookKey: 'connectedServices.materialization.openai',
        },
        quota: { capabilityIds: [] },
    }),
    defineConnectedAccountDescriptor({
        id: 'anthropic',
        kind: 'auth.connectedAccount',
        version: '1',
        displayKey: 'connectedServices.serviceNames.anthropic',
        aliases: ['claude'],
        credentialKinds: ['token'],
        defaultCredentialKind: 'token',
        connectModes: [
            { targetId: 'claude', mode: 'api-key', credentialKind: 'token', default: false, tokenKind: 'api-key' },
        ],
        tokenSetup: {
            tokenKind: 'api-key',
            promptLabelKey: 'connectedServices.tokenPrompts.anthropicApiKey',
            missingValueErrorKey: 'connectedServices.tokenPrompts.errors.missingApiKey',
        },
        ui: {
            connectCommand: 'happier connect claude --api-key',
            oauthAddActionModes: [],
            shortName: 'Anthropic',
        },
        materialization: {
            materializationKinds: ['agent_runtime_env'],
            hookKey: 'connectedServices.materialization.anthropic',
        },
        quota: { capabilityIds: [] },
    }),
    defineConnectedAccountDescriptor({
        id: 'claude-subscription',
        kind: 'auth.connectedAccount',
        version: '1',
        displayKey: 'connectedServices.serviceNames.claudeSubscription',
        aliases: ['claude'],
        credentialKinds: ['oauth', 'token'],
        defaultCredentialKind: 'token',
        connectModes: [
            { targetId: 'claude', mode: 'setup-token', credentialKind: 'token', default: true, tokenKind: 'setup-token' },
            { targetId: 'claude', mode: 'oauth', credentialKind: 'oauth', default: false },
        ],
        oauth: {
            publicClientId: {
                envKey: 'HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID',
                defaultValue: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
            },
            tokenUrl: {
                envKey: 'HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL',
                defaultValue: 'https://console.anthropic.com/v1/oauth/token',
            },
            authorization: {
                endpointUrl: 'https://claude.ai/oauth/authorize',
                defaultRedirectUri: 'https://platform.claude.com/oauth/code/callback',
                scopes: [
                    'user:inference',
                    'user:profile',
                    'user:sessions:claude_code',
                    'user:mcp_servers',
                    'user:file_upload',
                ],
                pkce: true,
                query: {
                    responseType: 'code',
                    extraParams: { code: 'true' },
                },
            },
            refresh: { body: 'json', hookKey: 'standard-oauth-refresh' },
            payloadMapping: {
                accessTokenField: 'access_token',
                refreshTokenField: 'refresh_token',
                scopeField: 'scope',
                tokenTypeField: 'token_type',
                providerAccountIdField: { objectField: 'account', field: 'uuid' },
                providerEmailField: { objectField: 'account', field: 'email_address' },
                expiresAt: { expiresInField: 'expires_in' },
            },
        },
        tokenSetup: {
            tokenKind: 'setup-token',
            promptLabelKey: 'connectedServices.tokenPrompts.claudeSetupToken',
            missingValueErrorKey: 'connectedServices.tokenPrompts.errors.missingSetupToken',
        },
        ui: {
            connectCommand: 'happier connect claude',
            oauthPasteCopyKeyPrefix: 'connectedServices.oauthPaste.providerOverrides.claudeSubscription',
            oauthAddActionModes: ['paste', 'browser'],
            shortName: 'Claude',
        },
        materialization: {
            materializationKinds: ['agent_runtime_env'],
            hookKey: 'connectedServices.materialization.claudeSubscription',
        },
        quota: {
            capabilityIds: ['connectedServices.quotas.claudeSubscription'],
            hookKey: 'connectedServices.quotas.claudeSubscription',
        },
    }),
    defineConnectedAccountDescriptor({
        id: 'gemini',
        kind: 'auth.connectedAccount',
        version: '1',
        displayKey: 'connectedServices.serviceNames.gemini',
        aliases: ['gemini'],
        credentialKinds: ['token'],
        defaultCredentialKind: 'token',
        connectModes: [
            { targetId: 'gemini', mode: 'api-key', credentialKind: 'token', tokenKind: 'api-key', default: true },
        ],
        tokenSetup: {
            tokenKind: 'api-key',
            promptLabelKey: 'connectedServices.tokenPrompts.geminiApiKey',
            missingValueErrorKey: 'connectedServices.tokenPrompts.errors.missingApiKey',
        },
        ui: {
            connectCommand: 'happier connect gemini',
            oauthAddActionModes: [],
            shortName: 'Gemini',
        },
        materialization: {
            materializationKinds: ['agent_runtime_env'],
            hookKey: 'connectedServices.materialization.gemini',
        },
        quota: {
            capabilityIds: ['connectedServices.quotas.gemini'],
            hookKey: 'connectedServices.quotas.gemini',
        },
    }),
    defineConnectedAccountDescriptor({
        id: 'github',
        kind: 'auth.connectedAccount',
        version: '1',
        displayKey: 'connectedServices.serviceNames.github',
        aliases: ['github'],
        credentialKinds: ['token'],
        defaultCredentialKind: 'token',
        connectModes: [
            {
                targetId: 'github',
                mode: 'token',
                credentialKind: 'token',
                default: true,
                tokenKind: 'personal-access-token',
            },
        ],
        tokenSetup: {
            tokenKind: 'personal-access-token',
            promptLabelKey: 'connectedServices.tokenPrompts.githubPersonalAccessToken',
            missingValueErrorKey: 'connectedServices.tokenPrompts.errors.missingPersonalAccessToken',
            setupUrl: buildGithubPersonalAccessTokenUrl(),
            permissions: {
                contents: 'write',
                pull_requests: 'write',
                administration: 'write',
            },
        },
        ui: {
            connectCommand: 'happier connect github --token',
            oauthAddActionModes: [],
            shortName: 'GitHub',
        },
        materialization: {
            materializationKinds: ['scm_hosting_token'],
            hookKey: 'connectedServices.materialization.githubScmHostingToken',
        },
        quota: { capabilityIds: [] },
    }),
] satisfies readonly ConnectedAccountDescriptor[]);

const DESCRIPTORS_BY_ID: ReadonlyMap<ConnectedServiceId, ConnectedAccountDescriptor> = new Map(
    CONNECTED_ACCOUNT_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
);

export function getConnectedAccountDescriptor(serviceId: string): ConnectedAccountDescriptor | null {
    const parsed = ConnectedServiceIdSchema.safeParse(serviceId);
    if (!parsed.success) return null;
    return DESCRIPTORS_BY_ID.get(parsed.data) ?? null;
}

export function requireConnectedAccountDescriptor(serviceId: string): ConnectedAccountDescriptor {
    const descriptor = getConnectedAccountDescriptor(serviceId);
    if (!descriptor) {
        throw new Error(`Unsupported connected account: ${serviceId}`);
    }
    return descriptor;
}

export function getConnectedAccountDescriptorsForTarget(targetId: string): readonly ConnectedAccountDescriptor[] {
    const normalized = String(targetId ?? '').trim().toLowerCase();
    if (!normalized) return [];
    return CONNECTED_ACCOUNT_DESCRIPTORS.filter((descriptor) =>
        descriptor.connectModes.some((mode) => mode.targetId.toLowerCase() === normalized)
        || descriptor.aliases.some((alias) => alias.toLowerCase() === normalized),
    );
}

export function getConnectedAccountConnectModesForTarget(
    targetId: string,
): ReadonlyArray<Readonly<{ descriptor: ConnectedAccountDescriptor; mode: ConnectedAccountConnectModeDescriptor }>> {
    const normalized = String(targetId ?? '').trim().toLowerCase();
    if (!normalized) return [];
    return CONNECTED_ACCOUNT_DESCRIPTORS.flatMap((descriptor) =>
        descriptor.connectModes
            .filter((mode) => mode.targetId.toLowerCase() === normalized)
            .map((mode) => ({ descriptor, mode })),
    );
}
