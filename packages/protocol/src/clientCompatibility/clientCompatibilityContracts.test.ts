import { describe, expect, it } from 'vitest';

import {
  CURRENT_PENDING_INPUT_PROTOCOL_VERSION,
  CLIENT_UPGRADE_REQUIRED_HTTP_STATUS,
  PENDING_INPUT_PROTOCOL_VERSION_V1,
  PENDING_INPUT_PROTOCOL_VERSION_V2,
  SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY,
  ClientVersionCheckRequestV1Schema,
  ClientVersionCheckResponseV1Schema,
  ClientUpgradeRequiredV1Schema,
  VERSION_ENDPOINT_PATH,
} from './index.js';

describe('client compatibility protocol contracts', () => {
  it('owns independent Runtime Activity and Pending Input capability thresholds', () => {
    expect(SESSION_SYNC_PROTOCOL_VERSION_RUNTIME_ACTIVITY).toBe(2);
    expect(PENDING_INPUT_PROTOCOL_VERSION_V1).toBe(1);
    expect(PENDING_INPUT_PROTOCOL_VERSION_V2).toBe(2);
    expect(CURRENT_PENDING_INPUT_PROTOCOL_VERSION).toBe(PENDING_INPUT_PROTOCOL_VERSION_V2);
  });

  it('owns the strict app-version endpoint independently from session capabilities', () => {
    expect(VERSION_ENDPOINT_PATH).toBe('/v1/version');
    expect(ClientVersionCheckRequestV1Schema.parse({
      v: 1,
      clientKind: 'ui-ios',
      appVersion: '0.11.0',
      releaseChannel: 'stable',
      appId: 'dev.happier.app',
    })).toEqual({
      v: 1,
      clientKind: 'ui-ios',
      appVersion: '0.11.0',
      releaseChannel: 'stable',
      appId: 'dev.happier.app',
    });

    const required = {
      v: 1 as const,
      status: 'upgrade-required' as const,
      minimumAppVersion: '0.12.0',
      latestAppVersion: '0.12.3',
      updateUrl: null,
    };
    expect(ClientVersionCheckResponseV1Schema.parse(required)).toEqual(required);
    expect(ClientVersionCheckResponseV1Schema.safeParse({
      v: 1,
      status: 'current',
      updateUrl: 'https://app.happier.dev/update',
    }).success).toBe(false);
    expect(ClientVersionCheckResponseV1Schema.safeParse({
      ...required,
      updateUrl: 'http://app.happier.dev/update',
    }).success).toBe(false);
  });

  it('keeps an app-version-only upgrade result available without a session protocol floor', () => {
    expect(CLIENT_UPGRADE_REQUIRED_HTTP_STATUS).toBe(426);
    expect(ClientUpgradeRequiredV1Schema.parse({
      error: 'client-upgrade-required',
      requirement: {
        v: 1,
        clientKind: 'ui-web',
        minimumAppVersion: '0.12.0',
        updateUrl: 'https://app.happier.dev/update',
      },
    })).toBeTruthy();
  });
});
