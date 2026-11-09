import { describe, expect, it } from 'vitest';

import {
  readAuthEmailPasswordFeatureEnv,
  readAuthMtlsFeatureEnv,
  readAuthFeatureEnv,
  readConnectedServicesFeatureEnv,
  readMachineLiveStreamFeatureEnv,
  readMachineTransferFeatureEnv,
  readPluginsFeatureEnv,
  readSessionAgentSwitchingFeatureEnv,
  readSessionBoardFeatureEnv,
  readSessionConversationsFeatureEnv,
  readSessionEphemeralRunnerFeatureEnv,
  readSessionFilteredListingFeatureEnv,
  readSessionFollowingFeatureEnv,
  readSessionHandoffFeatureEnv,
  readSessionUsageLimitRecoveryFeatureEnv,
  readTerminalFeatureEnv,
  readTeamsFeatureEnv,
} from './readFeatureEnv';

async function loadFeatureEnvModule(): Promise<Record<string, any>> {
  const modulePath = './readFeatureEnv';
  return import(modulePath) as Promise<Record<string, any>>;
}

describe('readPluginsFeatureEnv Collection deployment limits', () => {
  it('defaults and validates one coherent bounded Collection deployment policy', () => {
    expect(readPluginsFeatureEnv({} as NodeJS.ProcessEnv).collectionLimits).toEqual({
      maxRowEncodedBytes: 512 * 1024,
      maxBatchBytes: 16 * 1024 * 1024,
      maxBatchRows: 100,
      maxAccountRows: 10_000,
      maxAccountBytes: 256 * 1024 * 1024,
    });

    const valid: NodeJS.ProcessEnv = {
      HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: '524288',
      HAPPIER_COLLECTION_MAX_BATCH_BYTES: '16777216',
      HAPPIER_COLLECTION_MAX_BATCH_ROWS: '64',
      HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: '10000',
      HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: '268435456',
    };
    expect(readPluginsFeatureEnv(valid).collectionLimits).toEqual({
      maxRowEncodedBytes: 524_288,
      maxBatchBytes: 16_777_216,
      maxBatchRows: 64,
      maxAccountRows: 10_000,
      maxAccountBytes: 268_435_456,
    });

    for (const env of [
      { HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: '0' },
      { HAPPIER_COLLECTION_MAX_BATCH_BYTES: '16.5' },
      { HAPPIER_COLLECTION_MAX_BATCH_ROWS: '101' },
      { HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: '100001' },
      { HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: '1073741825' },
      {
        HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: '16777217',
        HAPPIER_COLLECTION_MAX_BATCH_BYTES: '16777216',
      },
      {
        HAPPIER_COLLECTION_MAX_BATCH_ROWS: '10001',
        HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: '10000',
      },
      {
        HAPPIER_COLLECTION_MAX_BATCH_BYTES: '268435457',
        HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: '268435456',
      },
    ]) {
      expect(() => readPluginsFeatureEnv(env as NodeJS.ProcessEnv)).toThrow(/HAPPIER_COLLECTION_/u);
    }
  });
});

describe('readTeamsFeatureEnv', () => {
  it('enables Teams by default and respects the canonical operator opt-out', () => {
    expect(readTeamsFeatureEnv({}).enabled).toBe(true);
    expect(readTeamsFeatureEnv({ HAPPIER_FEATURE_TEAMS__ENABLED: 'false' }).enabled).toBe(false);
  });

  it('defaults the Team credential-resource bits on and honors their operator opt-outs', () => {
    expect(readTeamsFeatureEnv({}).credentialResourcesEnabled).toBe(true);
    expect(readTeamsFeatureEnv({}).credentialResourcesExternalApiEnabled).toBe(true);
    expect(readTeamsFeatureEnv({
      HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '0',
    }).credentialResourcesEnabled).toBe(false);
    expect(readTeamsFeatureEnv({
      HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES_EXTERNAL_API__ENABLED: '0',
    }).credentialResourcesExternalApiEnabled).toBe(false);
  });
});

describe('shipped Session program feature env readers', () => {
  // Every one of these is a shipped capability, not a staged rollout: the env
  // variable is the operator opt-out, exactly like `teams` and `search`.
  it('defaults Session conversations on and honors the operator opt-out', () => {
    expect(readSessionConversationsFeatureEnv({}).conversationsEnabled).toBe(true);
    expect(readSessionConversationsFeatureEnv({
      HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '0',
    }).conversationsEnabled).toBe(false);
  });

  it('defaults Session following on and honors the operator opt-out', () => {
    expect(readSessionFollowingFeatureEnv({}).followingEnabled).toBe(true);
    expect(readSessionFollowingFeatureEnv({
      HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: 'false',
    }).followingEnabled).toBe(false);
  });

  it('defaults the Session Board on and honors the operator opt-out', () => {
    expect(readSessionBoardFeatureEnv({}).enabled).toBe(true);
    expect(readSessionBoardFeatureEnv({
      HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED: '0',
    }).enabled).toBe(false);
  });

  it('defaults filtered Session listing on and honors the operator opt-out', () => {
    expect(readSessionFilteredListingFeatureEnv({}).filteredListingEnabled).toBe(true);
    expect(readSessionFilteredListingFeatureEnv({
      HAPPIER_FEATURE_SESSIONS_FILTERED_LISTING__ENABLED: '0',
    }).filteredListingEnabled).toBe(false);
  });

  it('defaults the temporary-computer Runner on and honors the operator opt-out', () => {
    expect(readSessionEphemeralRunnerFeatureEnv({}).ephemeralRunnerEnabled).toBe(true);
    expect(readSessionEphemeralRunnerFeatureEnv({
      HAPPIER_FEATURE_SESSIONS_EPHEMERAL_RUNNER__ENABLED: '0',
    }).ephemeralRunnerEnabled).toBe(false);
  });
});

describe('readAuthEmailPasswordFeatureEnv', () => {
  // Native email/password is a shipped authentication method, not a staged
  // rollout. The functional deciders are the persisted Home governance policy
  // (`enabledMethodIds`) and transactional-mail readiness; these env keys are
  // only the operator opt-out, the same shape as `teams` and `search`.
  it('defaults both deployment values on and honors the operator opt-outs', () => {
    expect(readAuthEmailPasswordFeatureEnv({})).toEqual({ enabled: true, provisionEnabled: true });
    expect(readAuthEmailPasswordFeatureEnv({
      HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '0',
    }).enabled).toBe(false);
    expect(readAuthEmailPasswordFeatureEnv({
      HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED: 'false',
    }).provisionEnabled).toBe(false);
  });
});

describe('readConnectedServicesFeatureEnv', () => {
  it('defaults connected-service server features to true when env is unset', () => {
    const env: NodeJS.ProcessEnv = {};
    const res = readConnectedServicesFeatureEnv(env);
    expect(res.quotasEnabled).toBe(true);
    expect(res.accountGroupsEnabled).toBe(true);
    expect(res.accountFallbackEnabled).toBe(true);
  });

  it('reads connected-service account group feature env', () => {
    const res = readConnectedServicesFeatureEnv({
      HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '0',
      HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '0',
    } as NodeJS.ProcessEnv);

    expect(res.accountGroupsEnabled).toBe(false);
    expect(res.accountFallbackEnabled).toBe(false);
  });
});

describe('readAuthFeatureEnv', () => {
  it('falls back to legacy AUTH_UI_* env vars for auto-redirect', () => {
    const env: NodeJS.ProcessEnv = {
      AUTH_UI_AUTO_REDIRECT: 'true',
      AUTH_UI_AUTO_REDIRECT_PROVIDER_ID: 'mTLS',
    };
    const res = readAuthFeatureEnv(env);
    expect(res.uiAutoRedirectEnabled).toBe(true);
    expect(res.uiAutoRedirectProviderId).toBe('mtls');
  });

  it('prefers HAPPIER_FEATURE_AUTH_UI__* env vars over legacy AUTH_UI_* aliases', () => {
    const env: NodeJS.ProcessEnv = {
      AUTH_UI_AUTO_REDIRECT: 'true',
      AUTH_UI_AUTO_REDIRECT_PROVIDER_ID: 'mtls',
      HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED: 'false',
      HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_PROVIDER_ID: 'github',
    };
    const res = readAuthFeatureEnv(env);
    expect(res.uiAutoRedirectEnabled).toBe(false);
    expect(res.uiAutoRedirectProviderId).toBe('github');
  });

  it('falls back to legacy auth recovery env vars', () => {
    const env: NodeJS.ProcessEnv = {
      AUTH_RECOVERY_PROVIDER_RESET_ENABLED: 'false',
      AUTH_UI_RECOVERY_KEY_REMINDER_ENABLED: 'false',
    };
    const res = readAuthFeatureEnv(env);
    expect(res.recoveryProviderResetEnabled).toBe(false);
    expect(res.uiRecoveryKeyReminderEnabled).toBe(false);
  });
});

describe('readAuthMtlsFeatureEnv', () => {
  it('uses the effective local UI webapp URL in default returnTo allow-prefixes when HAPPIER_WEBAPP_URL is unset', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPIER_FEATURE_AUTH_MTLS__ENABLED: 'true',
      HAPPIER_PUBLIC_SERVER_URL: 'https://stack.example.test/base/',
      HAPPIER_SERVER_UI_DIR: '/tmp/ui',
      HAPPIER_SERVER_UI_PREFIX: '/ui/',
    };

    const res = readAuthMtlsFeatureEnv(env);
    expect(res.returnToAllowPrefixes).toEqual(['happier://', 'https://stack.example.test/base/ui']);
  });
});

describe('readTerminalFeatureEnv', () => {
  it('defaults embeddedPtyEnabled and transportByteStreamEnabled to true when env is unset', () => {
    const env: NodeJS.ProcessEnv = {};
    const res = readTerminalFeatureEnv(env);
    expect(res.embeddedPtyEnabled).toBe(true);
    expect(res.transportByteStreamEnabled).toBe(true);
  });

  it('keeps terminal byte-stream disabled when embedded PTY is disabled', () => {
    const res = readTerminalFeatureEnv({
      HAPPIER_FEATURE_TERMINAL_EMBEDDED_PTY__ENABLED: 'false',
      HAPPIER_FEATURE_TERMINAL_TRANSPORT_BYTE_STREAM__ENABLED: 'true',
    });

    expect(res.embeddedPtyEnabled).toBe(false);
    expect(res.transportByteStreamEnabled).toBe(false);
  });

  it('can disable terminal byte-stream while leaving embedded PTY available for legacy fallback', () => {
    const res = readTerminalFeatureEnv({
      HAPPIER_FEATURE_TERMINAL_EMBEDDED_PTY__ENABLED: 'true',
      HAPPIER_FEATURE_TERMINAL_TRANSPORT_BYTE_STREAM__ENABLED: 'false',
    });

    expect(res.embeddedPtyEnabled).toBe(true);
    expect(res.transportByteStreamEnabled).toBe(false);
  });
});

describe('readSessionHandoffFeatureEnv', () => {
  it('defaults session handoff enabled when env is unset', () => {
    const env: NodeJS.ProcessEnv = {};
    const res = readSessionHandoffFeatureEnv(env);

    expect(res.handoffEnabled).toBe(true);
  });
});

describe('readSessionUsageLimitRecoveryFeatureEnv', () => {
  it('defaults usage-limit recovery enabled when env is unset', () => {
    expect(readSessionUsageLimitRecoveryFeatureEnv({} as NodeJS.ProcessEnv).enabled).toBe(true);
  });

  it('reads usage-limit recovery enablement from env', () => {
    expect(readSessionUsageLimitRecoveryFeatureEnv({
      HAPPIER_FEATURE_SESSIONS_USAGE_LIMIT_RECOVERY__ENABLED: '0',
    } as NodeJS.ProcessEnv).enabled).toBe(false);
  });
});

describe('readSessionAgentSwitchingFeatureEnv', () => {
  it('defaults agent switching enabled when env is unset', () => {
    const env: NodeJS.ProcessEnv = {};
    const res = readSessionAgentSwitchingFeatureEnv(env);

    expect(res.agentSwitchingEnabled).toBe(true);
  });

  it('reads the opt-out env value', () => {
    for (const raw of ['0', 'false', 'no', 'off']) {
      const res = readSessionAgentSwitchingFeatureEnv({
        HAPPIER_FEATURE_SESSIONS_AGENT_SWITCHING__ENABLED: raw,
      });

      expect(res.agentSwitchingEnabled).toBe(false);
    }
  });

  it('falls back to the default for an unparseable env value', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPIER_FEATURE_SESSIONS_AGENT_SWITCHING__ENABLED: 'maybe',
    };
    const res = readSessionAgentSwitchingFeatureEnv(env);

    expect(res.agentSwitchingEnabled).toBe(true);
  });
});

describe('readMachineTransferFeatureEnv', () => {
  it('defaults direct-peer and server-routed transfer enabled when env is unset', () => {
    const env: NodeJS.ProcessEnv = {};
    const res = readMachineTransferFeatureEnv(env);

    expect(res.directPeerEnabled).toBe(true);
    expect(res.serverRoutedEnabled).toBe(true);
    // Must be bounded even when env is unset (prevents implicit unlimited server-routed streaming).
    expect(res.serverRoutedMaxBytes).toBe(2 * 1024 * 1024 * 1024);
  });

  it('reads server-routed transfer max-bytes when configured', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: '8192',
    };
    const res = readMachineTransferFeatureEnv(env);

    expect(res.serverRoutedMaxBytes).toBe(8192);
  });

  it('hard-clamps server-routed max-bytes to a bounded ceiling', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: String(999 * 1024 * 1024 * 1024),
    };
    const res = readMachineTransferFeatureEnv(env);

    expect(res.serverRoutedMaxBytes).toBe(8 * 1024 * 1024 * 1024);
  });
});

describe('readMachineLiveStreamFeatureEnv', () => {
  it('defaults direct peer and server relay enabled without imposing quality or lifetime caps', () => {
    const env: NodeJS.ProcessEnv = {};
    const res = readMachineLiveStreamFeatureEnv(env);

    expect(res.directPeerEnabled).toBe(true);
    expect(res.serverRoutedEnabled).toBe(true);
    expect(res.serverRoutedCaps).toEqual({});
  });

  it('honors explicit Home resource policy caps', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__ENABLED: 'true',
      HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: '64000',
      HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND: '12',
      HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES: '32000',
      HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS: '60000',
      HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES: '128000',
      HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT: '2',
      HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET: '1',
      HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE: '1',
    };
    const res = readMachineLiveStreamFeatureEnv(env);

    expect(res.serverRoutedEnabled).toBe(true);
    expect(res.serverRoutedCaps).toMatchObject({
      maxBitrateBps: 64_000,
      maxFramesPerSecond: 12,
      maxFrameBytes: 32_000,
      maxDurationMs: 60_000,
      maxTotalBytes: 128_000,
    });
  });

  it('accepts an individual optional Home cap and honors the relay toggle', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__ENABLED: 'true',
      HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: '64000',
    };
    const res = readMachineLiveStreamFeatureEnv(env);

    expect(res.serverRoutedEnabled).toBe(true);
    expect(res.serverRoutedCaps).toEqual({ maxBitrateBps: 64_000 });
    expect(readMachineLiveStreamFeatureEnv({
      HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__ENABLED: 'false',
    }).serverRoutedEnabled).toBe(false);
  });
});

describe('readMachineTunnelFeatureEnv', () => {
  it('defaults direct peer enabled and relay disabled without inventing tunnel or substream counts', async () => {
    const mod = await loadFeatureEnvModule();
    expect(mod.readMachineTunnelFeatureEnv).toBeTypeOf('function');

    const res = mod.readMachineTunnelFeatureEnv({});

    expect(res.directPeerEnabled).toBe(true);
    expect(res.serverRoutedEnabled).toBe(false);
    expect(res.serverRoutedMaxActiveTunnelsPerSocket).toBeUndefined();
    expect(res.serverRoutedSubstreams.maxConcurrentSubstreams).toBeUndefined();
    expect(res.serverRoutedMaxFrameBytes).toBe(64 * 1024);
  });

  it('reads server-routed tunnel policy from canonical feature env keys', async () => {
    const mod = await loadFeatureEnvModule();
    expect(mod.readMachineTunnelFeatureEnv).toBeTypeOf('function');
    const res = mod.readMachineTunnelFeatureEnv({
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: '1',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_ACTIVE_TUNNELS_PER_SOCKET: '2',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: '1024',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS: 'binary_frame_v2',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING: 'binary_frame_v2',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BINARY_HEADER_BYTES: '512',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES: '2048',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES: '4096',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_CONCURRENT_SUBSTREAMS: '8',
      HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: '3000,5173',
    });

    expect(res.serverRoutedEnabled).toBe(true);
    expect(res.serverRoutedMaxActiveTunnelsPerSocket).toBe(2);
    expect(res.serverRoutedMaxFrameBytes).toBe(1024);
    expect(res.serverRoutedSupportedEncodings).toEqual(['binary_frame_v2']);
    expect(res.serverRoutedPreferredEncoding).toBe('binary_frame_v2');
    expect(res.serverRoutedMaxBinaryHeaderBytes).toBe(512);
    expect(res.serverRoutedMaxRawPayloadBytes).toBe(2048);
    expect(res.serverRoutedMaxFramedMessageBytes).toBe(4096);
    expect(res.serverRoutedSubstreams).toMatchObject({
      maxConcurrentSubstreams: 8,
    });
    expect(res.allowedPorts).toEqual([3000, 5173]);
  });
});

describe('readLocalServicesFeatureEnv', () => {
  it('defaults private preview ON (loopback only) while public exposure stays disabled', async () => {
    const mod = await loadFeatureEnvModule();
    expect(mod.readLocalServicesFeatureEnv).toBeTypeOf('function');

    const res = mod.readLocalServicesFeatureEnv({});

    // PRV-1: private preview reaches the user's own loopback dev server — no internet exposure —
    // so it defaults ON. Public exposure (real internet reach) stays explicit/default-off.
    expect(res.previewEnabled).toBe(true);
    expect(res.publicPreviewEnabled).toBe(false);
    expect(res.publicPolicy.enabled).toBe(false);
  });

  it('allows an explicit env opt-out of the private-preview product', async () => {
    const mod = await loadFeatureEnvModule();

    const res = mod.readLocalServicesFeatureEnv({
      HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: '0',
    });

    expect(res.previewEnabled).toBe(false);
    expect(res.publicPreviewEnabled).toBe(false);
  });

  it('reads local-service preview and public exposure policy from canonical feature env keys', async () => {
    const mod = await loadFeatureEnvModule();
    expect(mod.readLocalServicesFeatureEnv).toBeTypeOf('function');

    const res = mod.readLocalServicesFeatureEnv({
      HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: '1',
      HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS: '120000',
      HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.example.test',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: '1',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: 'people,secret_link,authenticated',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: '600000',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: '0',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: 'default,strict',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: '1',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: '1',
    });

    expect(res.previewEnabled).toBe(true);
    expect(res.previewTokenTtlMs).toBe(120_000);
    expect(res.previewHostOriginBaseDomain).toBe('preview.example.test');
    expect(res.publicPreviewEnabled).toBe(true);
    expect(res.publicPolicy).toMatchObject({
      enabled: true,
      allowedModes: ['people', 'secret_link'],
      maxTtlMs: 600_000,
      dnsTlsRequired: false,
      auditRequired: true,
      rateLimitProfileIds: ['default', 'strict'],
    });
    expect(res.publicAuditTestSinkAllowed).toBe(true);
    expect(res.publicRateLimitTestCheckerAllowed).toBe(true);
  });

  it('ignores public exposure test audit and rate overrides in production', async () => {
    const mod = await loadFeatureEnvModule();
    expect(mod.readLocalServicesFeatureEnv).toBeTypeOf('function');

    const res = mod.readLocalServicesFeatureEnv({
      NODE_ENV: 'production',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: '1',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: '1',
    });

    expect(res.publicAuditTestSinkAllowed).toBe(false);
    expect(res.publicRateLimitTestCheckerAllowed).toBe(false);
  });

  it('reads real production public exposure audit and rate dependencies', async () => {
    const mod = await loadFeatureEnvModule();
    expect(mod.readLocalServicesFeatureEnv).toBeTypeOf('function');

    const res = mod.readLocalServicesFeatureEnv({
      NODE_ENV: 'production',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: 'jsonl_file',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: '/var/log/happier/public-preview-audit.jsonl',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: 'fixed_window',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: '120',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: '60000',
    });

    expect(res.publicAuditDependency).toEqual({
      kind: 'jsonl_file',
      path: '/var/log/happier/public-preview-audit.jsonl',
    });
    expect(res.publicRateLimitDependency).toEqual({
      kind: 'fixed_window',
      maxRequests: 120,
      windowMs: 60_000,
    });
  });
});

describe('feature reader defaults come from FEATURE_READER_DEFAULTS', () => {
  it('produces the declared default of every parse style for an empty env, and for values outside the declared bounds', async () => {
    const mod = await loadFeatureEnvModule();
    const d = mod.FEATURE_READER_DEFAULTS;
    const empty = {} as NodeJS.ProcessEnv;

    expect(mod.readWorkflowsFeatureEnv(empty).enabled).toBe(d.workflowsEnabled.default);
    expect(mod.readPetsFeatureEnv(empty).syncEnabled).toBe(d.petsSyncEnabled.default);
    expect(mod.readPetsFeatureEnv(empty).maxManifestBytes).toBe(d.petsSyncMaxManifestBytes.default);
    expect(mod.readBugReportsFeatureEnv(empty).contextWindowMs).toBe(d.bugReportsContextWindowMs.default);
    expect(
      mod.readBugReportsFeatureEnv({ HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: String(d.bugReportsContextWindowMs.bounds.max + 1) })
        .contextWindowMs,
    ).toBe(d.bugReportsContextWindowMs.default);
    expect(mod.readSocialFriendsFeatureEnv(empty).identityProvider).toBe(d.socialFriendsIdentityProvider.default);
    expect(mod.readAuthMtlsFeatureEnv(empty)).toMatchObject({
      mode: d.authMtlsMode.default,
      identitySource: d.authMtlsIdentitySource.default,
      forwardedEmailHeader: d.authMtlsForwardedEmailHeader.default,
      claimTtlSeconds: d.authMtlsClaimTtlSeconds.default,
    });
    expect(mod.readEncryptionFeatureEnv(empty)).toEqual({
      storagePolicy: d.encryptionStoragePolicy.default,
      allowAccountOptOut: d.encryptionAllowAccountOptOut.default,
      defaultAccountMode: d.encryptionDefaultAccountMode.default,
      plainAccountSettingsAtRest: d.encryptionPlainAccountSettingsAtRest.default,
      plainAccountCredentialsAtRest: d.encryptionPlainAccountCredentialsAtRest.default,
      plainAccountArtifactsAtRest: d.encryptionPlainAccountArtifactsAtRest.default,
    });
    expect(mod.readMachineTransferFeatureEnv(empty).serverRoutedMaxBytes).toBe(d.machinesTransferServerRoutedMaxBytes.default);
    expect(mod.readMachineTunnelFeatureEnv(empty).serverRoutedMaxFrameBytes).toBe(d.machinesTunnelServerRoutedMaxFrameBytes.default);
    expect(mod.readLocalServicesFeatureEnv(empty).previewTokenTtlMs).toBe(d.localServicesPreviewTokenTtlMs.default);
    const plugins = mod.readPluginsFeatureEnv(empty);
    expect(plugins.webhookIngressPolicy.route.ratePerMinute).toBe(d.pluginsWebhooksRouteRatePerMinute.default);
    expect(plugins.collectionLimits.maxBatchRows).toBe(d.collectionMaxBatchRows.default);
  });

  it('keeps the exact-case encryption policy parse and the legacy auth aliases', async () => {
    const mod = await loadFeatureEnvModule();
    expect(mod.readEncryptionFeatureEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'Optional' }).storagePolicy).toBe('required_e2ee');
    expect(readAuthFeatureEnv({ AUTH_UI_AUTO_REDIRECT: '1', AUTH_UI_AUTO_REDIRECT_PROVIDER_ID: ' GitHub ' } as NodeJS.ProcessEnv)).toMatchObject({
      uiAutoRedirectEnabled: true,
      uiAutoRedirectProviderId: 'github',
    });
  });
});
