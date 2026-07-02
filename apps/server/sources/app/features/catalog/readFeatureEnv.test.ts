import { describe, expect, it } from 'vitest';

import {
  readAuthMtlsFeatureEnv,
  readAuthFeatureEnv,
  readChannelBridgesFeatureEnv,
  readConnectedServicesFeatureEnv,
  readMachineLiveStreamFeatureEnv,
  readMachineTransferFeatureEnv,
  readSessionHandoffFeatureEnv,
  readSessionUsageLimitRecoveryFeatureEnv,
  readTerminalFeatureEnv,
} from './readFeatureEnv';

async function loadFeatureEnvModule(): Promise<Record<string, any>> {
  const modulePath = './readFeatureEnv';
  return import(modulePath) as Promise<Record<string, any>>;
}

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

describe('readChannelBridgesFeatureEnv', () => {
  it('defaults enabled to true when env is unset', () => {
    const env: NodeJS.ProcessEnv = {};
    const res = readChannelBridgesFeatureEnv(env);
    expect(res.enabled).toBe(true);
  });

  it('defaults telegramEnabled to true when env is unset', () => {
    const env: NodeJS.ProcessEnv = {};
    const res = readChannelBridgesFeatureEnv(env);
    expect(res.telegramEnabled).toBe(true);
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
  it('defaults embeddedPtyEnabled to true when env is unset', () => {
    const env: NodeJS.ProcessEnv = {};
    const res = readTerminalFeatureEnv(env);
    expect(res.embeddedPtyEnabled).toBe(true);
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
  it('defaults direct peer enabled but server relay disabled until relay caps are configured', () => {
    const env: NodeJS.ProcessEnv = {};
    const res = readMachineLiveStreamFeatureEnv(env);

    expect(res.directPeerEnabled).toBe(true);
    expect(res.serverRoutedEnabled).toBe(false);
    expect(res.serverRoutedCaps).toBeNull();
    expect(res.serverRoutedDisabledReason).toBe('relay_not_enabled');
  });

  it('enables server relay only when the operator provides all required positive caps', () => {
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

  it('keeps server relay disabled when enabled is true but a required cap is missing', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__ENABLED: 'true',
      HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: '64000',
    };
    const res = readMachineLiveStreamFeatureEnv(env);

    expect(res.serverRoutedEnabled).toBe(false);
    expect(res.serverRoutedCaps).toBeNull();
    expect(res.serverRoutedDisabledReason).toBe('relay_caps_missing');
  });
});

describe('readMachineTunnelFeatureEnv', () => {
  it('defaults direct peer enabled and server-routed relay disabled with bounded caps', async () => {
    const mod = await loadFeatureEnvModule();
    expect(mod.readMachineTunnelFeatureEnv).toBeTypeOf('function');

    const res = mod.readMachineTunnelFeatureEnv({});

    expect(res.directPeerEnabled).toBe(true);
    expect(res.serverRoutedEnabled).toBe(false);
    expect(res.serverRoutedMaxActiveTunnelsPerSocket).toBe(8);
    expect(res.serverRoutedMaxFrameBytes).toBe(64 * 1024);
  });

  it('reads server-routed tunnel policy from canonical feature env keys', async () => {
    const mod = await loadFeatureEnvModule();
    expect(mod.readMachineTunnelFeatureEnv).toBeTypeOf('function');
    const res = mod.readMachineTunnelFeatureEnv({
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ENABLED: '1',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES: '4096',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_ACTIVE_TUNNELS_PER_SOCKET: '2',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: '1024',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS: 'binary_frame_v2,json_base64_v1',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING: 'binary_frame_v2',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__ALLOW_V1_FALLBACK: '0',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BINARY_HEADER_BYTES: '512',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES: '2048',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES: '4096',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_CONCURRENT_SUBSTREAMS: '8',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_TOTAL_SUBSTREAMS: '64',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES_PER_SUBSTREAM: '8192',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_AGGREGATE_BYTES: '16384',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SUBSTREAM_IDLE_MS: '5000',
      HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SESSION_IDLE_MS: '10000',
      HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: '3000,5173',
    });

    expect(res.serverRoutedEnabled).toBe(true);
    expect(res.serverRoutedMaxBytes).toBe(4096);
    expect(res.serverRoutedMaxActiveTunnelsPerSocket).toBe(2);
    expect(res.serverRoutedMaxFrameBytes).toBe(1024);
    expect(res.serverRoutedSupportedEncodings).toEqual(['binary_frame_v2', 'json_base64_v1']);
    expect(res.serverRoutedPreferredEncoding).toBe('binary_frame_v2');
    expect(res.serverRoutedAllowV1Fallback).toBe(false);
    expect(res.serverRoutedMaxBinaryHeaderBytes).toBe(512);
    expect(res.serverRoutedMaxRawPayloadBytes).toBe(2048);
    expect(res.serverRoutedMaxFramedMessageBytes).toBe(4096);
    expect(res.serverRoutedSubstreams).toMatchObject({
      maxConcurrentSubstreams: 8,
      maxTotalSubstreams: 64,
      maxBytesPerSubstream: 8192,
      maxAggregateBytes: 16_384,
      maxSubstreamIdleMs: 5000,
      maxSessionIdleMs: 10_000,
    });
    expect(res.allowedPorts).toEqual([3000, 5173]);
  });
});

describe('readLocalServicesFeatureEnv', () => {
  it('defaults local-service preview and public exposure server features to disabled', async () => {
    const mod = await loadFeatureEnvModule();
    expect(mod.readLocalServicesFeatureEnv).toBeTypeOf('function');

    const res = mod.readLocalServicesFeatureEnv({});

    expect(res.previewEnabled).toBe(false);
    expect(res.publicPreviewEnabled).toBe(false);
    expect(res.publicPolicy.enabled).toBe(false);
  });

  it('reads local-service preview and public exposure policy from canonical feature env keys', async () => {
    const mod = await loadFeatureEnvModule();
    expect(mod.readLocalServicesFeatureEnv).toBeTypeOf('function');

    const res = mod.readLocalServicesFeatureEnv({
      HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__ENABLED: '1',
      HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS: '120000',
      HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: 'preview.example.test',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ENABLED: '1',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: 'authenticated,secret_link',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: '600000',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: '0',
      HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: 'default,strict',
    });

    expect(res.previewEnabled).toBe(true);
    expect(res.previewTokenTtlMs).toBe(120_000);
    expect(res.previewHostOriginBaseDomain).toBe('preview.example.test');
    expect(res.publicPreviewEnabled).toBe(true);
    expect(res.publicPolicy).toMatchObject({
      enabled: true,
      allowedModes: ['authenticated', 'secret_link'],
      maxTtlMs: 600_000,
      dnsTlsRequired: false,
      auditRequired: true,
      rateLimitProfileIds: ['default', 'strict'],
    });
  });
});
