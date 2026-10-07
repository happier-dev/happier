

export const en = {
    teams: {
        title: 'Teams',
        description: 'Groups with shared sessions, machines and access.',
        credentialResources: {
            title: 'Team credentials',
            description: 'Credentials a Team shares with its sessions.',
            externalApi: {
                title: 'Team credentials API',
                description: 'Lets outside tools use a Team’s credentials through the API.',
            },
        },
    },
    automations: {
        title: 'Automations',
        description: 'Scheduled and triggered agent work.',
    },
    workflows: {
        title: 'Workflows',
        description: 'Multi-step agent pipelines.',
    },
    pets: {
        sync: {
            title: 'Pet sync',
            description: 'Keeps each person’s pets on all their devices.',
        },
    },
    voice: {
        title: 'Voice',
        description: 'Talk to your agents.',
        happierVoice: {
            title: 'Happier voice',
            description: 'Voice through the voice service this Home provides.',
        },
    },
    connectedServices: {
        group: 'Connected services',
        quotas: {
            title: 'Quota meters',
            description: 'Shows how much quota each connected account has left.',
        },
        subscription: {
            title: 'Subscription status',
            description: 'Shows the plan and status of each connected account.',
        },
        accountGroups: {
            title: 'Account groups',
            description: 'Group connected accounts into pools.',
        },
        accountFallback: {
            title: 'Account fallback',
            description: 'Switch to the next account in a pool when one runs out.',
        },
        autoQuotaReset: {
            title: 'Automatic quota reset',
            description: 'Spend banked quota resets once every account in a pool runs out.',
        },
        autoDisablePlanInvalid: {
            title: 'Skip unusable accounts',
            description: 'Turn off pool accounts that can’t use the selected model.',
        },
        poolQuotaLimitSelection: {
            title: 'Pool quota limits',
            description: 'Choose which provider quota each pool follows.',
        },
    },
    updates: {
        ota: {
            title: 'Over-the-air updates',
            description: 'Apps install updates without a store release.',
        },
    },
    attachments: {
        uploads: {
            title: 'Attachments',
            description: 'Send files and images to agents in a session.',
        },
    },
    sharing: {
        group: 'Sharing',
        session: {
            title: 'Session sharing',
            description: 'Share a session with someone on this Home.',
        },
        public: {
            title: 'Public links',
            description: 'Share session content with a public link.',
        },
        contentKeys: {
            title: 'Encrypted sharing',
            description: 'Exchange keys so shared sessions stay end-to-end encrypted.',
        },
        pendingQueueV2: {
            title: 'Shared message queue',
            description: 'Queue messages for a shared session while its agent is busy.',
        },
        pendingDeliveryState: {
            title: 'Queue delivery tracking',
            description: 'Remember which queued messages reached the agent.',
        },
    },
    sessions: {
        title: 'Sessions',
        description: 'Sessions and their controls.',
        group: 'Sessions',
        handoff: {
            title: 'Session handoff',
            description: 'Move a running session to another machine.',
        },
        ephemeralRunner: {
            title: 'Ephemeral runners',
            description: 'Start a session on a throwaway machine.',
        },
        agentSwitching: {
            title: 'Agent switching',
            description: 'Continue a session with another coding agent.',
        },
        folders: {
            title: 'Session folders',
            description: 'Organise sessions in folders.',
        },
        drafts: {
            title: 'Synced drafts',
            description: 'Keep unsent messages and new-session drafts on every device.',
        },
        following: {
            title: 'Following',
            description: 'Follow a session to get its updates and notifications.',
        },
        conversations: {
            title: 'Conversations',
            description: 'People talk and mention each other inside a shared session.',
        },
        board: {
            title: 'Session board',
            description: 'Arrange sessions and their items on shared boards.',
        },
        filteredListing: {
            title: 'Filtered listing',
            description: 'Filter the session list on this Home before it pages.',
        },
        usageLimitRecovery: {
            title: 'Usage-limit recovery',
            description: 'Wait and resume, or retry, when an agent hits a usage limit.',
        },
    },
    machines: {
        title: 'Machines',
        description: 'Connecting to your machines.',
        group: 'Machines',
        pools: {
            title: 'Machine pools',
            description: 'Fall back to the next machine when one is offline.',
        },
        transfer: {
            title: 'Machine transfers',
            description: 'Moving data between machines.',
            directPeer: {
                title: 'Direct transfers',
                description: 'Move data straight between machines.',
            },
            serverRouted: {
                title: 'Transfers through this Home',
                description: 'Move data between machines through this Home when they can’t connect directly.',
            },
        },
        peerMediation: {
            title: 'Machine connections',
            description: 'Tunnels, streams and access between machines.',
            observability: {
                title: 'Connection diagnostics',
                description: 'Show how tunnels, streams and previews between machines are connected.',
            },
        },
        tunnel: {
            title: 'Machine tunnels',
            description: 'Opening ports between machines.',
            directPeer: {
                title: 'Direct tunnels',
                description: 'Open ports between machines directly.',
            },
            serverRouted: {
                title: 'Tunnels through this Home',
                description: 'Open ports between machines through this Home when they can’t connect directly.',
            },
        },
        liveStream: {
            title: 'Live streams',
            description: 'Streaming a machine’s screen.',
            directPeer: {
                title: 'Direct live streams',
                description: 'Stream a machine’s screen straight to your device.',
            },
            serverRouted: {
                title: 'Live streams through this Home',
                description: 'Stream a machine’s screen through this Home when a direct stream fails.',
            },
        },
        rpc: {
            title: 'Machine calls',
            description: 'Reaching machines directly.',
            directPeer: {
                title: 'Direct machine calls',
                description: 'Reach a machine directly instead of through this Home.',
            },
        },
    },
    localServices: {
        title: 'Local services',
        description: 'See and open the services running on your machines.',
        group: 'Local services',
        inventory: {
            title: 'Service inventory',
            description: 'List the ports and services running on each machine.',
        },
        managed: {
            title: 'Managed services',
            description: 'Start, name and watch services from Happier.',
        },
        launcher: {
            title: 'Service launcher',
            description: 'Suggest services to open and preview.',
        },
        actions: {
            title: 'Service actions',
            description: 'Copy, preview and forget services.',
            terminate: {
                title: 'Stop services',
                description: 'Stop a detected service’s process.',
            },
        },
        preview: {
            title: 'Service previews',
            description: 'Preview a local service privately inside a session.',
        },
        publicPreview: {
            title: 'Public previews',
            description: 'Share a service preview at a public address.',
        },
    },
    browser: {
        title: 'Browser',
        description: 'Open pages, previews and hosted views inside Happier.',
        group: 'Browser',
        viewTargets: {
            title: 'Browser views',
            description: 'Open previews, plugin pages and links in the right browser view.',
        },
        internal: {
            title: 'Built-in browser',
            description: 'Browse inside Happier with its own sessions and profiles.',
        },
        sidecar: {
            title: 'Sidecar browser',
            description: 'A separate managed browser for heavy automation.',
        },
        diagnostics: {
            title: 'Browser devtools',
            description: 'Console, network and devtools events from the built-in browser.',
        },
        context: {
            title: 'Browser context',
            description: 'Attach what’s on a page to a message or an agent.',
        },
        automation: {
            title: 'Browser automation',
            description: 'Let agents click, type and navigate in the built-in browser.',
        },
        recording: {
            title: 'Browser recordings',
            description: 'Record browser sessions as evidence.',
        },
    },
    plugins: {
        title: 'Plugins from outside Happier',
        description: 'Install plugins from npm and your own sources.',
        group: 'Plugins',
        webhooks: {
            title: 'Plugin webhooks',
            description: 'Let plugins receive webhooks from outside services.',
        },
        ui: {
            title: 'Plugin screens',
            description: 'Show the screens and panels plugins provide.',
            hostedWeb: {
                title: 'Web plugin screens',
                description: 'Show plugin screens built for the web.',
            },
            reactNativeBundles: {
                title: 'Native plugin screens',
                description: 'Run trusted plugin screens built with React Native.',
            },
        },
    },
    devices: {
        title: 'Devices',
        description: 'Simulators and connected devices.',
        simulatorPreview: {
            title: 'Simulator previews',
            description: 'Show simulators and emulators from your machines.',
        },
    },
    social: {
        friends: {
            title: 'Friends',
            description: 'Add friends and see what they share.',
        },
    },
    auth: {
        group: 'Sign-in',
        recovery: {
            providerReset: {
                title: 'Reset through a provider',
                description: 'Recover an account by signing in with its identity provider.',
            },
        },
        login: {
            keyChallenge: {
                title: 'Key sign-in',
                description: 'Sign in by proving a device’s key.',
            },
        },
        mtls: {
            title: 'Client certificates',
            description: 'Sign in with a client certificate (mTLS).',
        },
        ui: {
            recoveryKeyReminder: {
                title: 'Recovery key reminder',
                description: 'Remind people to save their recovery key.',
            },
        },
        pairing: {
            desktopQrMobileScan: {
                title: 'Sign in by scanning',
                description: 'Sign in on a phone by scanning a code on a computer.',
            },
            boundQrV2: {
                title: 'Safer pairing codes',
                description: 'Pairing codes that only work for this Home and direction.',
            },
        },
    },
    encryption: {
        group: 'Encryption',
        plaintextStorage: {
            title: 'Unencrypted storage',
            description: 'Store sessions without end-to-end encryption.',
        },
        accountOptOut: {
            title: 'Encryption opt-out',
            description: 'Let each person turn end-to-end encryption off.',
        },
    },
    remoteHosts: {
        group: 'Remote hosts',
        management: {
            title: 'Remote hosts',
            description: 'Save SSH hosts to run sessions on.',
        },
        secretMaterial: {
            title: 'Saved host secrets',
            description: 'Save passwords and keys for SSH hosts.',
        },
    },
    e2ee: {
        keylessAccounts: {
            title: 'Keyless accounts',
            description: 'Accounts without end-to-end encryption keys.',
        },
    },
    bugReports: {
        title: 'Bug reports',
        description: 'Send bug reports with diagnostics.',
    },
    terminal: {
        group: 'Terminal',
        embeddedPty: {
            title: 'Terminal',
            description: 'Open a terminal on a machine inside Happier.',
        },
        transport: {
            byteStream: {
                title: 'Streamed terminal',
                description: 'A faster connection for the built-in terminal.',
            },
        },
    },
    search: {
        title: 'Search',
        description: 'Search across sessions and transcripts.',
    },
    providers: {
        title: 'Model providers',
        description: 'Connect model providers and choose models for agents.',
        group: 'Model providers',
        localDiscovery: {
            title: 'Find local providers',
            description: 'Find model servers running on your machines.',
        },
        localModelManagement: {
            title: 'Local model management',
            description: 'Download and manage local models.',
        },
    },
    keys: {
        HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: {
            title: 'Report service address',
            description: 'Where bug reports are sent. Left blank, no report service is offered.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: {
            title: 'Include diagnostics by default',
            description: 'The report form includes diagnostics unless the reporter opts out.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES: {
            title: 'Largest attachment',
            description: 'Largest file a bug report may attach, in bytes.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__UPLOAD_TIMEOUT_MS: {
            title: 'Upload time limit',
            description: 'How long a bug report upload may take, in milliseconds.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__ACCEPTED_ARTIFACT_KINDS: {
            title: 'Accepted attachment kinds',
            description: 'Kinds of attachment bug reports accept. Empty accepts the usual kinds.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: {
            title: 'Context window',
            description: 'How far back a bug report collects context, in milliseconds.',
        },
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: {
            title: 'Voice needs a subscription',
            description: 'Only subscribers can use voice. When not set, production requires it and other setups don’t.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES: {
            title: 'Largest pet manifest',
            description: 'Largest pet manifest accepted, in bytes.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_SPRITESHEET_BYTES: {
            title: 'Largest pet spritesheet',
            description: 'Largest pet spritesheet accepted, in bytes.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_PACKAGE_BYTES: {
            title: 'Largest pet package',
            description: 'Largest pet package accepted, in bytes.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PETS_PER_ACCOUNT: {
            title: 'Imported pets per person',
            description: 'Most imported pets one person may keep.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PET_BYTES_PER_ACCOUNT: {
            title: 'Imported pet storage per person',
            description: 'Most bytes of imported pets one person may keep.',
        },
        HAPPIER_FEATURE_PETS_SYNC__ENCRYPTED_CUSTOM_PET_SYNC_POLICY: {
            title: 'Encrypted custom pets',
            description: 'Reserved for later. Encrypted custom pets are not synced yet, so this stays off.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: {
            title: 'Largest transfer through this Home',
            description: 'Largest file a transfer through this Home carries, in bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_ACTIVE_TRANSFERS_PER_SOCKET: {
            title: 'Transfers at once per connection',
            description: 'Most transfers through this Home one connection runs at once.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES: {
            title: 'Data per tunnel',
            description: 'Most bytes one tunnel through this Home carries.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_ACTIVE_TUNNELS_PER_SOCKET: {
            title: 'Tunnels per connection',
            description: 'Most tunnels through this Home one connection holds open.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Largest tunnel frame',
            description: 'Largest frame a tunnel through this Home carries, in bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS: {
            title: 'Tunnel encodings',
            description: 'Frame encodings tunnels through this Home accept. Empty uses the standard ones.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING: {
            title: 'Preferred tunnel encoding',
            description: 'The frame encoding to use first. It must be one of the accepted encodings.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BINARY_HEADER_BYTES: {
            title: 'Largest frame header',
            description: 'Largest binary frame header, in bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES: {
            title: 'Largest frame payload',
            description: 'Largest raw payload in one frame, in bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES: {
            title: 'Largest framed message',
            description: 'Largest framed message, in bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_CONCURRENT_SUBSTREAMS: {
            title: 'Streams at once per tunnel',
            description: 'Most streams one tunnel runs at once.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_TOTAL_SUBSTREAMS: {
            title: 'Streams per tunnel',
            description: 'Most streams one tunnel opens over its lifetime.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES_PER_SUBSTREAM: {
            title: 'Data per stream',
            description: 'Most bytes one stream carries.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_AGGREGATE_BYTES: {
            title: 'Data per tunnel, all streams',
            description: 'Most bytes all streams of one tunnel carry together.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SUBSTREAM_IDLE_MS: {
            title: 'Idle stream time limit',
            description: 'How long a stream may stay idle before it closes, in milliseconds.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SESSION_IDLE_MS: {
            title: 'Idle tunnel time limit',
            description: 'How long a tunnel through this Home may stay idle before it closes, in milliseconds.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_IDLE_MS: {
            title: 'Tunnel idle time limit',
            description: 'How long a tunnel may stay idle before it closes, in milliseconds.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_DURATION_MS: {
            title: 'Longest tunnel',
            description: 'Longest a tunnel stays open, in milliseconds.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: {
            title: 'Ports tunnels may reach',
            description: 'Ports tunnels may open. Empty allows only the default ones.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS: {
            title: 'Preview link lifetime',
            description: 'How long a private preview link works, in milliseconds.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: {
            title: 'Preview domain',
            description: 'Domain that serves each preview on its own address. Empty serves previews under this Home’s address.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: {
            title: 'Public preview modes',
            description: 'Ways a preview may be made public.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: {
            title: 'Longest public preview',
            description: 'Longest a preview stays public, in milliseconds. Empty keeps the standard limit.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_CONCURRENT_EXPOSURES: {
            title: 'Public previews at once',
            description: 'Most previews public at the same time. Empty keeps the standard limit.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: {
            title: 'Require DNS and TLS',
            description: 'Public previews need DNS and TLS.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: {
            title: 'Public preview audit log',
            description: 'Where public previews are recorded. Public previews need one.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: {
            title: 'Audit log file',
            description: 'File the public preview audit log is written to.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: {
            title: 'Allow the test audit log',
            description: 'For development only: accept the in-memory test audit log. Ignored in production.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: {
            title: 'Public preview rate limits',
            description: 'Rate-limit profiles public previews may use.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: {
            title: 'Rate-limit checker',
            description: 'How public preview requests are rate limited. Public previews need one.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: {
            title: 'Requests per window',
            description: 'Requests a public preview allows in each window.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: {
            title: 'Rate-limit window',
            description: 'Length of each rate-limit window, in milliseconds.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: {
            title: 'Allow the test rate limiter',
            description: 'For development only: accept the in-memory test rate limiter. Ignored in production.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS: {
            title: 'Webhooks in progress',
            description: 'Most webhook requests this server handles at once.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_WORKING_BYTES: {
            title: 'Webhook memory',
            description: 'Most memory webhook requests in progress may use, in bytes. Empty allows what the request limit already permits.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: {
            title: 'Webhooks per minute per route',
            description: 'Webhook requests per minute on one route.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: {
            title: 'Webhooks at once per route',
            description: 'Webhook requests in progress on one route.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: {
            title: 'Webhooks per minute per endpoint',
            description: 'Webhook requests per minute on one endpoint.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: {
            title: 'Webhooks at once per endpoint',
            description: 'Webhook requests in progress on one endpoint.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: {
            title: 'Webhooks per minute per person',
            description: 'Webhook requests per minute for one person.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: {
            title: 'Webhooks at once per person',
            description: 'Webhook requests in progress for one person.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: {
            title: 'Largest plugin screen bundle',
            description: 'Largest plugin screen bundle this Home hosts, in bytes.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: {
            title: 'Plugin screen storage per person',
            description: 'Most bytes of plugin screen bundles one person may store.',
        },
        HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: {
            title: 'Largest plugin data row',
            description: 'Largest row a plugin stores, in bytes.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_BYTES: {
            title: 'Largest plugin data batch',
            description: 'Largest batch of plugin data changes, in bytes.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_ROWS: {
            title: 'Rows per plugin data batch',
            description: 'Most rows in one batch of plugin data changes.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: {
            title: 'Plugin data rows per person',
            description: 'Most rows of plugin data one person may store.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: {
            title: 'Plugin data storage per person',
            description: 'Most bytes of plugin data one person may store.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: {
            title: 'Highest stream bitrate',
            description: 'Highest bitrate of a live stream through this Home, in bits per second.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND: {
            title: 'Highest stream frame rate',
            description: 'Highest frame rate of a live stream through this Home.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Largest stream frame',
            description: 'Largest frame of a live stream through this Home, in bytes.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS: {
            title: 'Longest live stream',
            description: 'Longest a live stream through this Home runs, in milliseconds.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES: {
            title: 'Data per live stream',
            description: 'Most bytes one live stream through this Home carries.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT: {
            title: 'Live streams at once per person',
            description: 'Most live streams through this Home one person runs at once.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET: {
            title: 'Live streams at once per connection',
            description: 'Most live streams through this Home one connection runs at once.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE: {
            title: 'Live streams at once per machine',
            description: 'Most live streams through this Home one machine runs at once.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: {
            title: 'Connection signing key ID',
            description: 'Names the key that signs connections between machines. Without a signing key, these connections are off.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: {
            title: 'Connection signing private key',
            description: 'Private key that signs connections between machines.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: {
            title: 'Connection signing public key',
            description: 'Public key matching the signing key. When empty it comes from the private key.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: {
            title: 'Signing key expiry',
            description: 'When the signing key expires, as a timestamp in milliseconds.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: {
            title: 'Find friends by username',
            description: 'People can find friends by username as well as by linked account.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER: {
            title: 'Friend matching provider',
            description: 'The sign-in provider used to match friends.',
        },
    },
};


export const homeFeatureTranslationsEnglish = { en } as const;