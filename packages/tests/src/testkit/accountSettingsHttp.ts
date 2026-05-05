import {
  accountSettingsParse,
  type AccountSettings,
} from '@happier-dev/protocol';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function getNullableSettingsString(record: UnknownRecord): string {
  const value = record.settings;
  if (value === null || value === undefined) return '{}';
  if (typeof value !== 'string') {
    throw new Error('Expected string settings');
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

export type AccountSettingsHttpRow = Readonly<{
  settings: AccountSettings;
  settingsVersion: number;
  rawSettings: string;
}>;

export async function readAccountSettingsV1(params: Readonly<{
  baseUrl: string;
  token: string;
}>): Promise<AccountSettingsHttpRow> {
  const response = await fetch(`${params.baseUrl}/v1/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
  });
  if (response.ok) {
    const json: unknown = await response.json().catch(() => null);
    const row = asRecord(json);
    if (!row) throw new Error('Expected account settings response object');

    const rawSettings = getNullableSettingsString(row);
    return {
      settings: accountSettingsParse(JSON.parse(rawSettings)),
      settingsVersion: getNumber(row, 'settingsVersion'),
      rawSettings,
    };
  }

  if (response.status !== 400) {
    throw new Error(`Failed to fetch account settings (status=${response.status})`);
  }

  const v2Response = await fetch(`${params.baseUrl}/v2/account/settings`, {
    headers: { Authorization: `Bearer ${params.token}` },
  });
  if (!v2Response.ok) {
    throw new Error(`Failed to fetch account settings v2 (status=${v2Response.status})`);
  }
  const v2Json: unknown = await v2Response.json().catch(() => null);
  const v2Row = asRecord(v2Json);
  if (!v2Row) throw new Error('Expected account settings v2 response object');
  const content = asRecord(v2Row.content);
  if (content && content.t !== 'plain') {
    throw new Error('Cannot parse encrypted account settings without a secret');
  }
  const rawSettings = JSON.stringify(content?.v ?? {});
  return {
    settings: accountSettingsParse(JSON.parse(rawSettings)),
    settingsVersion: getNumber(v2Row, 'version'),
    rawSettings,
  };
}

export async function writeAccountSettingsV1(params: Readonly<{
  baseUrl: string;
  token: string;
  settings: unknown;
  expectedVersion?: number;
}>): Promise<number> {
  const expectedVersion = params.expectedVersion ?? (await readAccountSettingsV1(params)).settingsVersion;
  const response = await fetch(`${params.baseUrl}/v1/account/settings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      settings: JSON.stringify(params.settings),
      expectedVersion,
    }),
  });
  if (response.ok) {
    const json: unknown = await response.json().catch(() => null);
    const row = asRecord(json);
    if (!row) throw new Error('Expected account settings write response object');
    if (row.success !== true) throw new Error('Expected account settings write success');
    return getNumber(row, 'version');
  }

  if (response.status !== 400) {
    throw new Error(`Failed to write account settings (status=${response.status})`);
  }

  const v2Response = await fetch(`${params.baseUrl}/v2/account/settings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expectedVersion,
      content: {
        t: 'plain',
        v: params.settings,
      },
    }),
  });
  if (!v2Response.ok) {
    throw new Error(`Failed to write account settings v2 (status=${v2Response.status})`);
  }
  const v2Json: unknown = await v2Response.json().catch(() => null);
  const v2Row = asRecord(v2Json);
  if (!v2Row) throw new Error('Expected account settings v2 write response object');
  if (v2Row.success !== true) throw new Error('Expected account settings v2 write success');
  return getNumber(v2Row, 'version');
}
