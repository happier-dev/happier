import { vi } from 'vitest';

import {
    DEFAULT_BROWSER_CAPABILITIES,
    DEFAULT_DEVICE_CAPABILITIES,
    DEFAULT_LOCAL_SERVICE_CAPABILITIES,
    DEFAULT_MACHINE_LIVE_STREAM_CAPABILITIES,
    DEFAULT_MACHINE_TUNNEL_CAPABILITIES,
    DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS,
    DEFAULT_PEER_MEDIATION_CAPABILITIES,
    DEFAULT_PETS_CAPABILITIES,
    DEFAULT_SHARING_CAPABILITIES,
    type FeaturesResponse,
} from '@happier-dev/protocol';

type FixtureOverrides = {
    friendsEnabled?: boolean;
    friendsAllowUsername?: boolean;
    friendsRequiredIdentityProviderId?: string | null;
    voiceEnabled?: boolean;
    happierVoiceEnabled?: boolean;
    voiceConfigured?: boolean;
    automationsEnabled?: boolean;
    connectedServicesQuotasEnabled?: boolean;
    updatesOtaEnabled?: boolean;
    pairingDesktopQrMobileScanEnabled?: boolean;
    petsCompanionEnabled?: boolean;
    petsSyncEnabled?: boolean;
    oauthProviders?: Record<string, { enabled: boolean; configured: boolean }>;
    authProviders?: Record<string, { enabled: boolean; configured: boolean }>;
};

export function buildServerFeaturesResponse(overrides: FixtureOverrides = {}): FeaturesResponse {
    const oauthProviders = overrides.oauthProviders ?? { github: { enabled: true, configured: true } };
    const authProviders = overrides.authProviders ?? {
        github: {
            enabled: true,
            configured: true,
        },
    };

    const voiceEnabled = overrides.voiceEnabled ?? false;
    const happierVoiceEnabled = overrides.happierVoiceEnabled ?? voiceEnabled;
    const voiceConfigured = overrides.voiceConfigured ?? happierVoiceEnabled;

    const authProvidersWithDetails = Object.fromEntries(
        Object.entries(authProviders).map(([id, state]) => [
            id,
            {
                enabled: state.enabled,
                configured: state.configured,
                restrictions: { usersAllowlist: false, orgsAllowlist: false, orgMatch: 'any' as const },
                offboarding: {
                    enabled: false,
                    intervalSeconds: 600,
                    mode: 'per-request-cache' as const,
                    source: 'oauth_user_token',
                },
            },
        ]),
    );

    return {
        features: {
            bugReports: { enabled: true },
            providers: {
                enabled: false,
                localDiscovery: { enabled: false },
                localModelManagement: { enabled: false },
            },
            e2ee: {
                keylessAccounts: { enabled: false },
            },
            encryption: {
                plaintextStorage: { enabled: false },
                accountOptOut: { enabled: false },
            },
            remoteHosts: {
                management: { enabled: true },
                secretMaterial: { enabled: false },
            },
            attachments: {
                uploads: { enabled: true },
            },
            pets: {
                companion: { enabled: overrides.petsCompanionEnabled ?? false },
                sync: { enabled: overrides.petsSyncEnabled ?? false },
            },
            automations: {
                enabled: overrides.automationsEnabled ?? true,
            },
            connectedServices: {
                enabled: true,
                accountGroups: {
                    enabled: false,
                },
                accountFallback: {
                    enabled: false,
                },
                quotas: {
                    enabled: overrides.connectedServicesQuotasEnabled ?? false,
                },
            },
            updates: {
                ota: {
                    enabled: overrides.updatesOtaEnabled ?? true,
                },
            },
            sharing: {
                session: { enabled: true },
                public: { enabled: true },
                contentKeys: { enabled: true },
                pendingQueueV2: { enabled: false },
                pendingDeliveryState: { enabled: false },
            },
            sessions: {
                enabled: false,
                folders: {
                    enabled: false,
                },
                handoff: {
                    enabled: false,
                },
                agentSwitching: {
                    enabled: false,
                },
                usageLimitRecovery: {
                    enabled: false,
                },
            },
            machines: {
                enabled: false,
                peerMediation: {
                    enabled: false,
                    observability: { enabled: false },
                },
                transfer: {
                    enabled: false,
                    directPeer: {
                        enabled: false,
                    },
                    serverRouted: {
                        enabled: false,
                    },
                },
                tunnel: {
                    enabled: false,
                    directPeer: { enabled: false },
                    serverRouted: { enabled: false },
                },
                liveStream: {
                    enabled: false,
                    directPeer: { enabled: false },
                    serverRouted: { enabled: false },
                },
                rpc: {
                    enabled: false,
                    directPeer: { enabled: false },
                },
            },
            localServices: {
                enabled: false,
                inventory: { enabled: false },
                managed: { enabled: false },
                launcher: { enabled: false },
                actions: { enabled: false, terminate: { enabled: false } },
                preview: { enabled: false },
                publicPreview: { enabled: false },
            },
            browser: {
                enabled: false,
                viewTargets: { enabled: false },
                internal: { enabled: false },
                sidecar: { enabled: false },
                diagnostics: { enabled: false },
                context: { enabled: false },
                automation: { enabled: false },
                recording: { enabled: false, attachments: { enabled: false } },
            },
            plugins: {
                enabled: false,
                webhooks: { enabled: false },
                ui: {
                    enabled: false,
                    hostedWeb: { enabled: false },
                    reactNativeBundles: {
                        enabled: false,
                        devHotReload: { enabled: false },
                    },
                },
            },
            devices: {
                enabled: false,
                simulatorPreview: { enabled: false },
            },
            setup: {
                relay: {
                    allowRelaySelection: { enabled: true },
                    allowHappierCloud: { enabled: true },
                    allowCustomRelayUrl: { enabled: true },
                    allowLocalRelayHost: { enabled: true },
                    allowRemoteSshRelayHost: { enabled: true },
                },
                relayAccess: {
                    allowTailscale: { enabled: true },
                    allowCloudflareTunnel: { enabled: true },
                },
                machine: {
                    allowLocalMachineSetup: { enabled: true },
                    allowRemoteSshMachineSetup: { enabled: true },
                },
                ssh: {
                    nativeTransport: { enabled: false },
                },
            },
            terminal: {
                embeddedPty: { enabled: false },
                transport: {
                    byteStream: { enabled: false },
                },
            },
            voice: {
                enabled: voiceEnabled,
                happierVoice: { enabled: happierVoiceEnabled },
            },
            social: {
                friends: {
                    enabled: overrides.friendsEnabled ?? true,
                },
            },
            auth: {
                recovery: {
                    providerReset: { enabled: false },
                },
                mtls: { enabled: false },
                login: {
                    keyChallenge: { enabled: true },
                },
                pairing: {
                    desktopQrMobileScan: { enabled: overrides.pairingDesktopQrMobileScanEnabled ?? true },
                },
                ui: {
                    recoveryKeyReminder: { enabled: true },
                },
            },
        },
        capabilities: {
            connectedServices: { credentialDelete: { revisionGuard: false } },
            bugReports: {
                providerUrl: 'https://reports.happier.dev',
                defaultIncludeDiagnostics: true,
                maxArtifactBytes: 10 * 1024 * 1024,
                acceptedArtifactKinds: ['ui-mobile', 'daemon', 'server', 'cli'],
                uploadTimeoutMs: 20_000,
                contextWindowMs: 30 * 60 * 1_000,
            },
            voice: {
                configured: voiceConfigured,
                provider: voiceConfigured ? 'elevenlabs' : null,
                requested: voiceEnabled,
                disabledByBuildPolicy: false,
            },
            pets: DEFAULT_PETS_CAPABILITIES,
            encryption: {
                storagePolicy: 'required_e2ee',
                allowAccountOptOut: false,
                defaultAccountMode: 'e2ee',
                plainAccountSettingsAtRest: 'server_sealed',
                plainAccountCredentialsAtRest: 'server_sealed',
            },
            machines: {
                transfer: {
                    serverRouted: {
                        maxBytes: null,
                    },
                },
                tunnel: DEFAULT_MACHINE_TUNNEL_CAPABILITIES,
                liveStream: DEFAULT_MACHINE_LIVE_STREAM_CAPABILITIES,
                peerMediation: {
                    ...DEFAULT_PEER_MEDIATION_CAPABILITIES,
                },
            },
            localServices: DEFAULT_LOCAL_SERVICE_CAPABILITIES,
            browser: DEFAULT_BROWSER_CAPABILITIES,
            devices: DEFAULT_DEVICE_CAPABILITIES,
            plugins: { uiArtifactHosting: { enabled: false } },
            sharing: DEFAULT_SHARING_CAPABILITIES,
            server: {},
            serverIdentity: { serverIdentityId: null },
            social: {
                friends: {
                    allowUsername: overrides.friendsAllowUsername ?? false,
                    requiredIdentityProviderId: overrides.friendsRequiredIdentityProviderId ?? null,
                },
            },
            oauth: {
                providers: oauthProviders,
            },
            auth: {
                methods: [],
                signup: { methods: [{ id: 'anonymous', enabled: true }] },
                login: { methods: [{ id: 'key_challenge', enabled: true }], requiredProviders: [] },
                recovery: {
                    providerReset: { providers: [] },
                },
                mtls: {
                    mode: 'forwarded',
                    autoProvision: false,
                    identitySource: 'san_email',
                    policy: {
                        trustForwardedHeaders: false,
                        issuerAllowlist: { enabled: false, count: 0 },
                        emailDomainAllowlist: { enabled: false, count: 0 },
                    },
                },
                ui: {
                    autoRedirect: { enabled: false, providerId: null },
                },
                providers: authProvidersWithDetails,
                misconfig: [],
            },
            session: {
                messages: {
                    role: false,
                },
                state: {},
            },
            liveActivities: {
                remoteUpdates: DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS,
            },
        },
    };
}

export async function stubServerFeaturesFetch(overrides: FixtureOverrides = {}): Promise<void> {
    const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();

    // Some hook tests rely on `serverFetch` paths that require an active server profile. In sharded runs,
    // other suites may have mutated persisted server state; ensure we always have an active server.
    const profiles = await import('@/sync/domains/server/serverProfiles');
    const active = profiles.getActiveServerSnapshot();
    if (!String(active?.serverId ?? '').trim()) {
        const profile = profiles.upsertServerProfile({ serverUrl: 'https://features.test', name: 'Features Test' });
        profiles.setActiveServerId(profile.id, { scope: 'device' });
    }

    const response = buildServerFeaturesResponse(overrides);
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
            ok: true,
            json: async () => response,
        })) as any,
    );
}

export async function stubServerFeaturesFetchFailure(): Promise<void> {
    const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    resetServerFeaturesClientForTests();

    const profiles = await import('@/sync/domains/server/serverProfiles');
    const active = profiles.getActiveServerSnapshot();
    if (!String(active?.serverId ?? '').trim()) {
        const profile = profiles.upsertServerProfile({ serverUrl: 'https://features.test', name: 'Features Test' });
        profiles.setActiveServerId(profile.id, { scope: 'device' });
    }

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : String((input as any)?.url ?? input);
            if (url.endsWith('/health')) {
                return { ok: true, status: 200 } as any;
            }
            if (url.endsWith('/v1/auth/ping')) {
                return { ok: true, status: 200 } as any;
            }
            throw new Error('network down');
        }) as any,
    );
}
