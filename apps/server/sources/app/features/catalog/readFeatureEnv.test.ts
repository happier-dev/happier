import { describe, expect, it } from 'vitest';

import {
  readAuthFeatureEnv,
  readConnectedServicesFeatureEnv,
  readMachineTransferFeatureEnv,
  readSessionHandoffFeatureEnv,
  readTerminalFeatureEnv,
} from './readFeatureEnv';

describe('readConnectedServicesFeatureEnv', () => {
  it('defaults quotasEnabled to true when env is unset', () => {
    const env: NodeJS.ProcessEnv = {};
    const res = readConnectedServicesFeatureEnv(env);
    expect(res.quotasEnabled).toBe(true);
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
    expect(res.serverRoutedMaxBytes).toBeNull();
  });

  it('reads server-routed transfer max-bytes when configured', () => {
    const env: NodeJS.ProcessEnv = {
      HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: '8192',
    };
    const res = readMachineTransferFeatureEnv(env);

    expect(res.serverRoutedMaxBytes).toBe(8192);
  });
});
