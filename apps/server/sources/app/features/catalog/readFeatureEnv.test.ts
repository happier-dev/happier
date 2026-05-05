import { describe, expect, it } from 'vitest';

import {
  readAuthMtlsFeatureEnv,
  readAuthFeatureEnv,
  readChannelBridgesFeatureEnv,
  readConnectedServicesFeatureEnv,
  readMachineLiveStreamFeatureEnv,
  readMachineTransferFeatureEnv,
  readSessionHandoffFeatureEnv,
  readTerminalFeatureEnv,
} from './readFeatureEnv';

async function loadFeatureEnvModule(): Promise<Record<string, any>> {
  const modulePath = './readFeatureEnv';
  return import(modulePath) as Promise<Record<string, any>>;
}

describe('readConnectedServicesFeatureEnv', () => {
  it('defaults quotasEnabled to true when env is unset', () => {
    const env: NodeJS.ProcessEnv = {};
    const res = readConnectedServicesFeatureEnv(env);
    expect(res.quotasEnabled).toBe(true);
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
      HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: '3000,5173',
    });

    expect(res.serverRoutedEnabled).toBe(true);
    expect(res.serverRoutedMaxBytes).toBe(4096);
    expect(res.serverRoutedMaxActiveTunnelsPerSocket).toBe(2);
    expect(res.serverRoutedMaxFrameBytes).toBe(1024);
    expect(res.allowedPorts).toEqual([3000, 5173]);
  });
});
