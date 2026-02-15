import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

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

describe('core e2e: voice local_neural model-pack settings roundtrip', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop().catch(() => {});
    server = null;
  }, 60_000);

  it('roundtrips local_neural tts/stt settings inside account settings blob', async () => {
    const testDir = run.testDir(`voice-local-tts-kokoro-settings-roundtrip-${randomUUID()}`);
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
      voice: {
        adapters: {
          local_conversation: {
            tts: {
              provider: 'local_neural',
              localNeural: { model: 'kokoro', assetId: 'kokoro-82m-v1.0-onnx-q8-wasm', voiceId: 'af_heart', speed: 1 },
            },
            stt: {
              provider: 'local_neural',
              localNeural: { assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17', language: 'en' },
            },
          },
        },
      },
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

    const rawSettings = getRow2.settings;
    if (rawSettings === null) throw new Error('Expected non-null settings blob');
    const settingsBlob = getString(getRow2, 'settings');
    const parsed = JSON.parse(settingsBlob) as any;
    expect(parsed?.voice?.adapters?.local_conversation?.tts?.provider).toBe('local_neural');
    expect(parsed?.voice?.adapters?.local_conversation?.tts?.localNeural?.model).toBe('kokoro');
    expect(parsed?.voice?.adapters?.local_conversation?.tts?.localNeural?.voiceId).toBe('af_heart');
    expect(parsed?.voice?.adapters?.local_conversation?.tts?.localNeural?.assetId).toBe('kokoro-82m-v1.0-onnx-q8-wasm');

    expect(parsed?.voice?.adapters?.local_conversation?.stt?.provider).toBe('local_neural');
    expect(parsed?.voice?.adapters?.local_conversation?.stt?.localNeural?.assetId).toBe('sherpa-onnx-streaming-zipformer-en-20M-2023-02-17');
    expect(parsed?.voice?.adapters?.local_conversation?.stt?.localNeural?.language).toBe('en');

    // Ensure installation state stays device-local (never synced).
    expect(parsed?.voice?.adapters?.local_conversation?.tts?.localNeural?.packDirUri).toBeUndefined();
    expect(parsed?.voice?.adapters?.local_conversation?.stt?.localNeural?.packDirUri).toBeUndefined();
  }, 240_000);
});
