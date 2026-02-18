import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { accountSettingsParse, getNotificationsSettingsV1FromAccountSettings } from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';

const run = createRunDirs({ runLabel: 'core' });

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function getString(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected string ${key}`);
  }
  return value;
}

function getNumber(record: UnknownRecord, key: string): number {
  const value = record[key];
  if (typeof value !== 'number') {
    throw new Error(`Expected number ${key}`);
  }
  return value;
}

describe('core e2e: account settings notifications roundtrip', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop().catch(() => {});
    server = null;
  }, 60_000);

  it('roundtrips notificationsSettingsV1 and parses via protocol defaults', async () => {
    const testDir = run.testDir(`account-settings-notifications-roundtrip-${randomUUID()}`);
    server = await startServerLight({ testDir });

    const auth = await createTestAuth(server.baseUrl);
    const getRes = await fetch(`${server.baseUrl}/v1/account/settings`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    expect(getRes.ok).toBe(true);
    const getJson: unknown = await getRes.json().catch(() => null);
    const getRow = asRecord(getJson);
    if (!getRow) throw new Error('Expected account settings response object');
    const settingsVersion = getNumber(getRow, 'settingsVersion');

    const nextSettings = {
      schemaVersion: 2,
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: false },
      unknownFutureKey: { nested: true },
    };

    const postRes = await fetch(`${server.baseUrl}/v1/account/settings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        settings: JSON.stringify(nextSettings),
        expectedVersion: settingsVersion,
      }),
    });
    expect(postRes.ok).toBe(true);
    const postJson: unknown = await postRes.json().catch(() => null);
    const postRow = asRecord(postJson);
    if (!postRow) throw new Error('Expected account settings write response object');
    expect(postRow.success).toBe(true);
    expect(getNumber(postRow, 'version')).toBe(settingsVersion + 1);

    const getRes2 = await fetch(`${server.baseUrl}/v1/account/settings`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    expect(getRes2.ok).toBe(true);
    const getJson2: unknown = await getRes2.json().catch(() => null);
    const getRow2 = asRecord(getJson2);
    if (!getRow2) throw new Error('Expected account settings response object');
    expect(getNumber(getRow2, 'settingsVersion')).toBe(settingsVersion + 1);

    const settingsBlob = getString(getRow2, 'settings');
    const raw = JSON.parse(settingsBlob) as unknown;
    const parsed = accountSettingsParse(raw);

    const notifications = getNotificationsSettingsV1FromAccountSettings(parsed);
    expect(notifications.pushEnabled).toBe(true);
    expect(notifications.ready).toBe(true);
    expect(notifications.permissionRequest).toBe(false);

    // Ensure forward-compat: unknown keys survive roundtrip + parse.
    expect((parsed as any).unknownFutureKey).toEqual({ nested: true });
  }, 240_000);
});

