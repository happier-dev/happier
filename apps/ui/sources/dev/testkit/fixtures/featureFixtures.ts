import { ACCOUNT_STORED_CONTENT_PROFILE_PRESERVING_SETTINGS_WRITER_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { FeatureGatesSchema } from '@happier-dev/protocol/features/payload/featureGatesSchema';
import { DEFAULT_BROWSER_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import { DEFAULT_DEVICE_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/deviceCapabilities';
import { DEFAULT_LOCAL_SERVICE_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/localServiceCapabilities';
import { DEFAULT_MACHINE_LIVE_STREAM_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/machineLiveStreamCapabilities';
import { DEFAULT_MACHINE_TUNNEL_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/machineTunnelCapabilities';
import { DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS } from '@happier-dev/protocol/activity/live/remoteUpdateCapabilities';
import { DEFAULT_PEER_MEDIATION_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/peerMediationCapabilities';
import { DEFAULT_PETS_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/petsCapabilities';
import { DEFAULT_SESSION_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/sessionCapabilities';
import { DEFAULT_SHARING_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/sharingCapabilities';
import type { FeaturesResponse as RootLayoutFeatures } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

export const DEFAULT_AUTH_KEY_CHALLENGE_CAPABILITIES = {
    v2: false,
} as const;

type RootLayoutFeaturesOverrides = Omit<Partial<RootLayoutFeatures>, 'features' | 'capabilities'> & Readonly<{
    features?: Omit<
        Partial<RootLayoutFeatures['features']>,
        | 'attachments'
        | 'automations'
        | 'connectedServices'
        | 'updates'
        | 'sharing'
        | 'sessions'
        | 'machines'
        | 'localServices'
        | 'browser'
        | 'plugins'
        | 'devices'
        | 'terminal'
        | 'voice'
        | 'social'
        | 'auth'
        | 'encryption'
        | 'e2ee'
        | 'pets'
        | 'providers'
        | 'teams'
    > &
        Readonly<{
            attachments?: Partial<RootLayoutFeatures['features']['attachments']>;
            automations?: Partial<RootLayoutFeatures['features']['automations']>;
            connectedServices?: Partial<RootLayoutFeatures['features']['connectedServices']>;
            updates?: Partial<RootLayoutFeatures['features']['updates']>;
            sharing?: Partial<RootLayoutFeatures['features']['sharing']>;
            sessions?: Partial<RootLayoutFeatures['features']['sessions']>;
            machines?: Partial<RootLayoutFeatures['features']['machines']>;
            localServices?: Partial<RootLayoutFeatures['features']['localServices']>;
            browser?: Partial<RootLayoutFeatures['features']['browser']>;
            plugins?: Partial<RootLayoutFeatures['features']['plugins']>;
            devices?: Partial<RootLayoutFeatures['features']['devices']>;
            terminal?: Partial<RootLayoutFeatures['features']['terminal']>;
            voice?: Partial<RootLayoutFeatures['features']['voice']>;
            social?: Partial<RootLayoutFeatures['features']['social']>;
            auth?: Partial<RootLayoutFeatures['features']['auth']>;
            encryption?: Partial<RootLayoutFeatures['features']['encryption']>;
            e2ee?: Partial<RootLayoutFeatures['features']['e2ee']>;
            pets?: Partial<RootLayoutFeatures['features']['pets']>;
            providers?: Partial<RootLayoutFeatures['features']['providers']>;
            teams?: Partial<RootLayoutFeatures['features']['teams']>;
        }>;
    capabilities?: Omit<
        Partial<RootLayoutFeatures['capabilities']>,
        'oauth' | 'social' | 'auth' | 'encryption' | 'liveActivities' | 'pets' | 'localServices' | 'browser' | 'devices'
    > &
        Readonly<{
            oauth?: Partial<RootLayoutFeatures['capabilities']['oauth']>;
            social?: Partial<RootLayoutFeatures['capabilities']['social']>;
            auth?: Partial<RootLayoutFeatures['capabilities']['auth']>;
            encryption?: Partial<RootLayoutFeatures['capabilities']['encryption']>;
            liveActivities?: Partial<RootLayoutFeatures['capabilities']['liveActivities']>;
            pets?: Partial<RootLayoutFeatures['capabilities']['pets']>;
            localServices?: Partial<RootLayoutFeatures['capabilities']['localServices']>;
            browser?: Partial<RootLayoutFeatures['capabilities']['browser']>;
            devices?: Partial<RootLayoutFeatures['capabilities']['devices']>;
        }>;
}>;

const BASE_ROOT_LAYOUT_FEATURES: RootLayoutFeatures = {
    features: {
        artifacts: FeatureGatesSchema.shape.artifacts.parse(undefined),
        account: FeatureGatesSchema.shape.account.parse(undefined),
        // Current Homes advertise deployments by default; schema omission models an older Home.
        deployments: { enabled: true },
        teams: FeatureGatesSchema.shape.teams.parse(undefined),
        bugReports: { enabled: true },
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
        providers: {
            enabled: false,
            localDiscovery: { enabled: false },
            localModelManagement: { enabled: false },
        },
        attachments: {
            uploads: { enabled: true },
        },
        pets: {
            companion: { enabled: false },
            sync: { enabled: false },
        },
        automations: {
            enabled: true,
        },
        workflows: {
            enabled: true,
        },
        search: {
            enabled: false,
        },
        connectedServices: {
            enabled: true,
            quotas: { enabled: true },
            accountGroups: { enabled: false },
            accountFallback: { enabled: false },
            autoQuotaReset: { enabled: false },
            autoDisablePlanInvalid: { enabled: false },
            subscription: { enabled: false },
            poolQuotaLimitSelection: { enabled: false },
        },
        updates: {
            ota: { enabled: true },
        },
        sharing: {
            session: { enabled: true },
            public: { enabled: true },
            contentKeys: { enabled: true },
            pendingQueueV2: { enabled: false },
            pendingDeliveryState: { enabled: false },
        },
        sessions: FeatureGatesSchema.shape.sessions.parse(undefined),
        machines: FeatureGatesSchema.shape.machines.parse(undefined),
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
        voice: { enabled: false, happierVoice: { enabled: false } },
        social: {
            friends: {
                enabled: true,
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
                desktopQrMobileScan: { enabled: true },
                boundQrV2: { enabled: true },
            },
            ui: {
                recoveryKeyReminder: { enabled: true },
            },
        },
    },
    capabilities: {
        accountStoredContentCompatibility: {
            v: 1,
            minimumProtocolVersion: 2,
            currentProtocolVersion: ACCOUNT_STORED_CONTENT_PROFILE_PRESERVING_SETTINGS_WRITER_PROTOCOL_VERSION,
            declarationTransport: 'http-header-and-socket-auth-v1',
        },
        connectedServices: { credentialDelete: { revisionGuard: false } },
        bugReports: {
            providerUrl: 'https://reports.happier.dev',
            defaultIncludeDiagnostics: true,
            maxArtifactBytes: 10 * 1024 * 1024,
            acceptedArtifactKinds: ['ui-mobile', 'daemon', 'server', 'cli'],
            uploadTimeoutMs: 20_000,
            contextWindowMs: 30 * 60 * 1_000,
        },
        voice: { configured: false, provider: null, requested: false, disabledByBuildPolicy: false },
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
                allowUsername: false,
                requiredIdentityProviderId: 'github',
            },
        },
        oauth: { providers: { github: { enabled: true, configured: true } } },
        auth: {
            methods: [],
            keyChallenge: DEFAULT_AUTH_KEY_CHALLENGE_CAPABILITIES,
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
            providers: {
                github: {
                    enabled: true,
                    configured: true,
                    restrictions: { usersAllowlist: false, orgsAllowlist: false, orgMatch: 'any' },
                    offboarding: { enabled: false, intervalSeconds: 600, mode: 'per-request-cache', source: 'oauth_user_token' },
                },
            },
            misconfig: [],
        },
        session: DEFAULT_SESSION_CAPABILITIES,
        liveActivities: {
            remoteUpdates: DEFAULT_LIVE_ACTIVITY_REMOTE_UPDATE_CAPABILITY_DIAGNOSTICS,
        },
    },
};

/**
 * Fixture responses are written in place by `tryWriteServerEnabledBitInPlace`,
 * which walks to the owning gate object and assigns `enabled` on it. The
 * override ladder below only re-spreads the subtrees it has explicit override
 * keys for, so every other nested gate — `sessions.conversations`,
 * `sharing.session`, and their siblings — would still
 * be the exact object held by the module-level base. One test enabling a gate
 * would then silently enable it for every later fixture in the same worker.
 * Handing out a structurally independent response keeps each test's primed
 * server snapshot its own.
 */
function independentRootLayoutFeatures(response: RootLayoutFeatures): RootLayoutFeatures {
    return structuredClone(response);
}

export function createRootLayoutFeaturesResponse(overrides?: RootLayoutFeaturesOverrides): RootLayoutFeatures {
    const next = overrides ?? {};
    const nextFeatures: NonNullable<RootLayoutFeaturesOverrides['features']> = next.features ?? {};
    const nextCapabilities: NonNullable<RootLayoutFeaturesOverrides['capabilities']> = next.capabilities ?? {};

    const nextAuth: Partial<RootLayoutFeatures['features']['auth']> = nextFeatures.auth ?? {};
    const nextSocial: Partial<RootLayoutFeatures['features']['social']> = nextFeatures.social ?? {};
    const nextSharing: Partial<RootLayoutFeatures['features']['sharing']> = nextFeatures.sharing ?? {};
    const nextSessions: Partial<RootLayoutFeatures['features']['sessions']> = nextFeatures.sessions ?? {};
    const nextMachines: Partial<RootLayoutFeatures['features']['machines']> = nextFeatures.machines ?? {};
    const nextLocalServices: Partial<RootLayoutFeatures['features']['localServices']> = nextFeatures.localServices ?? {};
    const nextBrowser: Partial<RootLayoutFeatures['features']['browser']> = nextFeatures.browser ?? {};
    const nextPlugins: Partial<RootLayoutFeatures['features']['plugins']> = nextFeatures.plugins ?? {};
    const nextDevices: Partial<RootLayoutFeatures['features']['devices']> = nextFeatures.devices ?? {};
    const nextTerminal: Partial<RootLayoutFeatures['features']['terminal']> = nextFeatures.terminal ?? {};
    const nextAttachments: Partial<RootLayoutFeatures['features']['attachments']> = nextFeatures.attachments ?? {};
    const nextEncryption: Partial<RootLayoutFeatures['features']['encryption']> = nextFeatures.encryption ?? {};
    const nextE2ee: Partial<RootLayoutFeatures['features']['e2ee']> = nextFeatures.e2ee ?? {};
    const nextPets: Partial<RootLayoutFeatures['features']['pets']> = nextFeatures.pets ?? {};
    const nextConnectedServices: Partial<RootLayoutFeatures['features']['connectedServices']> =
        nextFeatures.connectedServices ?? {};
    const nextUpdates: Partial<RootLayoutFeatures['features']['updates']> = nextFeatures.updates ?? {};
    const nextAutomations: Partial<RootLayoutFeatures['features']['automations']> = nextFeatures.automations ?? {};

    const nextCapabilitiesAuth: Partial<RootLayoutFeatures['capabilities']['auth']> = nextCapabilities.auth ?? {};
    const nextCapabilitiesSocial: Partial<RootLayoutFeatures['capabilities']['social']> = nextCapabilities.social ?? {};
    const nextCapabilitiesOauth: Partial<RootLayoutFeatures['capabilities']['oauth']> = nextCapabilities.oauth ?? {};
    const nextCapabilitiesEncryption: Partial<RootLayoutFeatures['capabilities']['encryption']> =
        nextCapabilities.encryption ?? {};
    const nextCapabilitiesLiveActivities: Partial<RootLayoutFeatures['capabilities']['liveActivities']> =
        nextCapabilities.liveActivities ?? {};
    const nextCapabilitiesPets: Partial<RootLayoutFeatures['capabilities']['pets']> = nextCapabilities.pets ?? {};
    const nextCapabilitiesLocalServices: Partial<RootLayoutFeatures['capabilities']['localServices']> =
        nextCapabilities.localServices ?? {};
    const nextCapabilitiesBrowser: Partial<RootLayoutFeatures['capabilities']['browser']> = nextCapabilities.browser ?? {};
    const nextCapabilitiesDevices: Partial<RootLayoutFeatures['capabilities']['devices']> = nextCapabilities.devices ?? {};
    const nextCapabilitiesAuthRecovery: Partial<RootLayoutFeatures['capabilities']['auth']['recovery']> =
        nextCapabilitiesAuth.recovery ?? {};
    const nextCapabilitiesAuthUi: Partial<RootLayoutFeatures['capabilities']['auth']['ui']> =
        nextCapabilitiesAuth.ui ?? {};

    return independentRootLayoutFeatures({
        ...next,
        features: {
            ...BASE_ROOT_LAYOUT_FEATURES.features,
            ...nextFeatures,
            providers: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.providers,
                ...nextFeatures.providers,
            },
            teams: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.teams,
                ...nextFeatures.teams,
            },
            e2ee: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.e2ee,
                ...nextE2ee,
                keylessAccounts: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.e2ee.keylessAccounts,
                    ...(nextE2ee.keylessAccounts ?? {}),
                },
            },
            encryption: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.encryption,
                ...nextEncryption,
                plaintextStorage: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.encryption.plaintextStorage,
                    ...(nextEncryption.plaintextStorage ?? {}),
                },
                accountOptOut: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.encryption.accountOptOut,
                    ...(nextEncryption.accountOptOut ?? {}),
                },
            },
            attachments: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.attachments,
                ...nextAttachments,
            },
            pets: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.pets,
                ...nextPets,
                companion: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.pets.companion,
                    ...(nextPets.companion ?? {}),
                },
                sync: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.pets.sync,
                    ...(nextPets.sync ?? {}),
                },
            },
            sharing: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.sharing,
                ...nextSharing,
            },
            sessions: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.sessions,
                ...nextSessions,
                drafts: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.sessions.drafts,
                    ...(nextSessions.drafts ?? {}),
                },
                folders: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.sessions.folders,
                    ...(nextSessions.folders ?? {}),
                },
                handoff: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.sessions.handoff,
                    ...(nextSessions.handoff ?? {}),
                },
                usageLimitRecovery: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.sessions.usageLimitRecovery,
                    ...(nextSessions.usageLimitRecovery ?? {}),
                },
            },
            machines: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.machines,
                ...nextMachines,
                transfer: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.machines.transfer,
                    ...(nextMachines.transfer ?? {}),
                    directPeer: {
                        ...BASE_ROOT_LAYOUT_FEATURES.features.machines.transfer.directPeer,
                        ...(nextMachines.transfer?.directPeer ?? {}),
                    },
                    serverRouted: {
                        ...BASE_ROOT_LAYOUT_FEATURES.features.machines.transfer.serverRouted,
                        ...(nextMachines.transfer?.serverRouted ?? {}),
                    },
                },
                peerMediation: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.machines.peerMediation,
                    ...(nextMachines.peerMediation ?? {}),
                    observability: {
                        ...BASE_ROOT_LAYOUT_FEATURES.features.machines.peerMediation.observability,
                        ...(nextMachines.peerMediation?.observability ?? {}),
                    },
                },
                tunnel: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.machines.tunnel,
                    ...(nextMachines.tunnel ?? {}),
                    directPeer: {
                        ...BASE_ROOT_LAYOUT_FEATURES.features.machines.tunnel.directPeer,
                        ...(nextMachines.tunnel?.directPeer ?? {}),
                    },
                    serverRouted: {
                        ...BASE_ROOT_LAYOUT_FEATURES.features.machines.tunnel.serverRouted,
                        ...(nextMachines.tunnel?.serverRouted ?? {}),
                    },
                },
                liveStream: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.machines.liveStream,
                    ...(nextMachines.liveStream ?? {}),
                    directPeer: {
                        ...BASE_ROOT_LAYOUT_FEATURES.features.machines.liveStream.directPeer,
                        ...(nextMachines.liveStream?.directPeer ?? {}),
                    },
                    serverRouted: {
                        ...BASE_ROOT_LAYOUT_FEATURES.features.machines.liveStream.serverRouted,
                        ...(nextMachines.liveStream?.serverRouted ?? {}),
                    },
                },
                rpc: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.machines.rpc,
                    ...(nextMachines.rpc ?? {}),
                    directPeer: {
                        ...BASE_ROOT_LAYOUT_FEATURES.features.machines.rpc.directPeer,
                        ...(nextMachines.rpc?.directPeer ?? {}),
                    },
                },
            },
            localServices: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.localServices,
                ...nextLocalServices,
                inventory: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.localServices.inventory,
                    ...(nextLocalServices.inventory ?? {}),
                },
                managed: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.localServices.managed,
                    ...(nextLocalServices.managed ?? {}),
                },
                preview: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.localServices.preview,
                    ...(nextLocalServices.preview ?? {}),
                },
                publicPreview: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.localServices.publicPreview,
                    ...(nextLocalServices.publicPreview ?? {}),
                },
            },
            browser: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.browser,
                ...nextBrowser,
                viewTargets: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.browser.viewTargets,
                    ...(nextBrowser.viewTargets ?? {}),
                },
                internal: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.browser.internal,
                    ...(nextBrowser.internal ?? {}),
                },
                sidecar: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.browser.sidecar,
                    ...(nextBrowser.sidecar ?? {}),
                },
                diagnostics: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.browser.diagnostics,
                    ...(nextBrowser.diagnostics ?? {}),
                },
                context: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.browser.context,
                    ...(nextBrowser.context ?? {}),
                },
            },
            plugins: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.plugins,
                ...nextPlugins,
                ui: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.plugins.ui,
                    ...(nextPlugins.ui ?? {}),
                    hostedWeb: {
                        ...BASE_ROOT_LAYOUT_FEATURES.features.plugins.ui.hostedWeb,
                        ...(nextPlugins.ui?.hostedWeb ?? {}),
                    },
                    reactNativeBundles: {
                        ...BASE_ROOT_LAYOUT_FEATURES.features.plugins.ui.reactNativeBundles,
                        ...(nextPlugins.ui?.reactNativeBundles ?? {}),
                    },
                },
            },
            devices: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.devices,
                ...nextDevices,
                simulatorPreview: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.devices.simulatorPreview,
                    ...(nextDevices.simulatorPreview ?? {}),
                },
            },
            terminal: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.terminal,
                ...nextTerminal,
                transport: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.terminal.transport,
                    ...(nextTerminal.transport ?? {}),
                    byteStream: {
                        ...BASE_ROOT_LAYOUT_FEATURES.features.terminal.transport.byteStream,
                        ...(nextTerminal.transport?.byteStream ?? {}),
                    },
                },
            },
            voice: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.voice,
                ...(nextFeatures.voice ?? {}),
            },
            automations: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.automations,
                ...nextAutomations,
            },
            connectedServices: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.connectedServices,
                ...nextConnectedServices,
                quotas: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.connectedServices.quotas,
                    ...(nextConnectedServices.quotas ?? {}),
                },
                accountGroups: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.connectedServices.accountGroups,
                    ...(nextConnectedServices.accountGroups ?? {}),
                },
                accountFallback: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.connectedServices.accountFallback,
                    ...(nextConnectedServices.accountFallback ?? {}),
                },
            },
            updates: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.updates,
                ...nextUpdates,
                ota: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.updates.ota,
                    ...(nextUpdates.ota ?? {}),
                },
            },
            social: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.social,
                ...nextSocial,
                friends: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.social.friends,
                    ...(nextSocial.friends ?? {}),
                },
            },
            auth: {
                ...BASE_ROOT_LAYOUT_FEATURES.features.auth,
                ...nextAuth,
                recovery: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.auth.recovery,
                    ...(nextAuth.recovery ?? {}),
                },
                mtls: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.auth.mtls,
                    ...(nextAuth.mtls ?? {}),
                },
                login: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.auth.login,
                    ...(nextAuth.login ?? {}),
                    keyChallenge: {
                        ...BASE_ROOT_LAYOUT_FEATURES.features.auth.login.keyChallenge,
                        ...(nextAuth.login?.keyChallenge ?? {}),
                    },
                },
                ui: {
                    ...BASE_ROOT_LAYOUT_FEATURES.features.auth.ui,
                    ...(nextAuth.ui ?? {}),
                },
            },
        },
        capabilities: {
            ...BASE_ROOT_LAYOUT_FEATURES.capabilities,
            ...nextCapabilities,
            voice: {
                ...BASE_ROOT_LAYOUT_FEATURES.capabilities.voice,
                ...(nextCapabilities.voice ?? {}),
            },
            encryption: {
                ...BASE_ROOT_LAYOUT_FEATURES.capabilities.encryption,
                ...nextCapabilitiesEncryption,
            },
            liveActivities: {
                ...BASE_ROOT_LAYOUT_FEATURES.capabilities.liveActivities,
                ...nextCapabilitiesLiveActivities,
            },
            pets: {
                ...BASE_ROOT_LAYOUT_FEATURES.capabilities.pets,
                ...nextCapabilitiesPets,
                limits: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.pets.limits,
                    ...(nextCapabilitiesPets.limits ?? {}),
                },
            },
            localServices: {
                ...BASE_ROOT_LAYOUT_FEATURES.capabilities.localServices,
                ...nextCapabilitiesLocalServices,
                preview: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.localServices.preview,
                    ...(nextCapabilitiesLocalServices.preview ?? {}),
                },
                publicPreview: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.localServices.publicPreview,
                    ...(nextCapabilitiesLocalServices.publicPreview ?? {}),
                },
            },
            browser: {
                ...BASE_ROOT_LAYOUT_FEATURES.capabilities.browser,
                ...nextCapabilitiesBrowser,
                viewTargets: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.browser.viewTargets,
                    ...(nextCapabilitiesBrowser.viewTargets ?? {}),
                },
                internal: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.browser.internal,
                    ...(nextCapabilitiesBrowser.internal ?? {}),
                },
                sidecar: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.browser.sidecar,
                    ...(nextCapabilitiesBrowser.sidecar ?? {}),
                },
                diagnostics: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.browser.diagnostics,
                    ...(nextCapabilitiesBrowser.diagnostics ?? {}),
                },
                context: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.browser.context,
                    ...(nextCapabilitiesBrowser.context ?? {}),
                },
            },
            devices: {
                ...BASE_ROOT_LAYOUT_FEATURES.capabilities.devices,
                ...nextCapabilitiesDevices,
                simulatorPreview: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.devices.simulatorPreview,
                    ...(nextCapabilitiesDevices.simulatorPreview ?? {}),
                },
            },
            social: {
                ...BASE_ROOT_LAYOUT_FEATURES.capabilities.social,
                ...nextCapabilitiesSocial,
                friends: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.social.friends,
                    ...(nextCapabilitiesSocial.friends ?? {}),
                },
            },
            oauth: {
                ...BASE_ROOT_LAYOUT_FEATURES.capabilities.oauth,
                ...nextCapabilitiesOauth,
                providers: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.oauth.providers,
                    ...(nextCapabilitiesOauth.providers ?? {}),
                },
            },
            auth: {
                ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth,
                ...nextCapabilitiesAuth,
                signup: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.signup,
                    ...(nextCapabilitiesAuth.signup ?? {}),
                },
                login: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.login,
                    ...(nextCapabilitiesAuth.login ?? {}),
                },
                recovery: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.recovery,
                    ...nextCapabilitiesAuthRecovery,
                    providerReset: {
                        ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.recovery.providerReset,
                        ...(nextCapabilitiesAuthRecovery.providerReset ?? {}),
                    },
                },
                ui: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.ui,
                    ...nextCapabilitiesAuthUi,
                    autoRedirect: {
                        ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.ui.autoRedirect,
                        ...(nextCapabilitiesAuthUi.autoRedirect ?? {}),
                    },
                },
                providers: {
                    ...BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.providers,
                    ...(nextCapabilitiesAuth.providers ?? {}),
                },
                misconfig: nextCapabilitiesAuth.misconfig ?? BASE_ROOT_LAYOUT_FEATURES.capabilities.auth.misconfig,
            },
        },
    });
}

/** A Directory-capable Home that delegates no sign-in requests. */
export function createSignInServiceFeaturesResponse(endpointUrl: string): RootLayoutFeatures {
    return {
        ...createRootLayoutFeaturesResponse({
            capabilities: {
                server: { canonicalServerUrl: endpointUrl },
                serverIdentity: { serverIdentityId: 'srv_accounts_entry' },
                accountDirectory: {
                    version: 1, homeDirectory: true, homeEnrollment: true,
                    homeLoginAssertion: { keyId: 'a'.repeat(64), publicKeyBase64Url: 'A'.repeat(43) },
                },
                auth: {
                    methods: [{ id: 'key_challenge', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] }],
                    keyChallenge: { v2: true },
                },
            },
        }),
        signInService: { v: 1, mode: 'disabled' },
        accountServicePresentation: { v: 1, displayName: 'Example Accounts' },
    };
}

export function createOkFetchResponse<T>(payload: T): Promise<Response> {
    const response = {
        ok: true,
        json: async () => payload,
    };
    return Promise.resolve(response as Response);
}
