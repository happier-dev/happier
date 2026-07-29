import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  deriveVoiceModelPackDirectoryKeyV1,
  type InstalledVoiceModelPackMetadataV1,
} from '@happier-dev/voice-modelpacks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDaemonPublicVoiceModelPackStateStore } from './state';

let root: string;
let stateFilePath: string;

const metadata: InstalledVoiceModelPackMetadataV1 = {
  schemaVersion: 1,
  identity: { pluginId: 'acme.speech', packId: 'english' },
  directoryKey: deriveVoiceModelPackDirectoryKeyV1({ pluginId: 'acme.speech', packId: 'english' }),
  pluginVersion: '2.0.0',
  pluginSourceDigest: `sha256:${'b'.repeat(64)}`,
  packVersion: '1.0.0',
  manifestDigest: 'c'.repeat(64),
  verifiedAtMs: 100,
};
const licenseBinding = {
  licenseSourceUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
  licenseTextDigest: `sha256:${'c'.repeat(64)}`,
  artifactDigest: metadata.pluginSourceDigest,
} as const;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'happier-public-model-pack-state-'));
  stateFilePath = join(root, 'voiceInference', 'public-model-packs.v1.json');
  await mkdir(join(root, 'voiceInference'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('daemon public voice model-pack durable state', () => {
  it('persists structured installed identity and exact account/machine-bound license acceptance', async () => {
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await store.recordInstalled(metadata);
    await store.acceptLicense({
      identity: metadata.identity,
      packVersion: metadata.packVersion,
      licenseId: 'Apache-2.0',
      ...licenseBinding,
      acceptedAtMs: 200,
    });

    const restarted = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await expect(restarted.read()).resolves.toMatchObject({
      schemaVersion: 1,
      accountId: 'account-a',
      machineId: 'machine-a',
      installed: [{ identity: metadata.identity, directoryKey: metadata.directoryKey }],
      licenseAcceptances: [{
        accountId: 'account-a',
        executionHost: 'daemon',
        hostId: 'machine-a',
        pluginId: 'acme.speech',
        packId: 'english',
        packVersion: '1.0.0',
        licenseId: 'Apache-2.0',
        ...licenseBinding,
        acceptedAtMs: 200,
      }],
    });
  });

  it('preserves the exact validated license URL used by the contribution binding', async () => {
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    const exactLicenseUrl = 'https://licenses.example.test';

    await store.acceptLicense({
      identity: metadata.identity,
      packVersion: metadata.packVersion,
      licenseId: 'Example-1.0',
      licenseSourceUrl: exactLicenseUrl,
      licenseTextDigest: licenseBinding.licenseTextDigest,
      artifactDigest: licenseBinding.artifactDigest,
      acceptedAtMs: 200,
    });

    await expect(store.read()).resolves.toMatchObject({
      licenseAcceptances: [{ licenseSourceUrl: exactLicenseUrl }],
    });
  });

  it('fails closed across account or machine scope without deleting the durable file', async () => {
    const owner = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await owner.recordInstalled(metadata);
    const before = await readFile(stateFilePath, 'utf8');

    const wrongAccount = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-b',
      machineId: 'machine-a',
    });
    await expect(wrongAccount.read()).rejects.toThrow('voice_model_pack_state_scope_mismatch');
    expect(await readFile(stateFilePath, 'utf8')).toBe(before);
  });

  it('retains legacy unbound license records but never returns them as accepted', async () => {
    await writeFile(stateFilePath, JSON.stringify({
      schemaVersion: 1,
      accountId: 'account-a',
      machineId: 'machine-a',
      installed: [],
      licenseAcceptances: [{
        pluginId: 'acme.speech',
        packId: 'english',
        packVersion: '1.0.0',
        licenseId: 'Apache-2.0',
        pluginSourceDigest: metadata.pluginSourceDigest,
      }],
    }), 'utf8');
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });

    const state = await store.read();
    expect(state.licenseAcceptances).toEqual([]);
    expect(state.unboundLicenseAcceptances).toHaveLength(1);
    await store.recordInstalled(metadata);
    const durable = JSON.parse(await readFile(stateFilePath, 'utf8')) as {
      unboundLicenseAcceptances?: unknown[];
    };
    expect(durable.unboundLicenseAcceptances).toHaveLength(1);
  });

  it('quarantines a syntactically bound acceptance whose account or host disagrees with the state envelope', async () => {
    await writeFile(stateFilePath, JSON.stringify({
      schemaVersion: 1,
      accountId: 'account-a',
      machineId: 'machine-a',
      installed: [],
      licenseAcceptances: [{
        accountId: 'account-b',
        executionHost: 'daemon',
        hostId: 'machine-a',
        pluginId: 'acme.speech',
        packId: 'english',
        packVersion: '1.0.0',
        licenseId: 'Apache-2.0',
        pluginSourceDigest: metadata.pluginSourceDigest,
        acceptedAtMs: 200,
      }],
    }), 'utf8');
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });

    const state = await store.read();
    expect(state.licenseAcceptances).toEqual([]);
    expect(state.unboundLicenseAcceptances).toHaveLength(1);
  });

  it('rejects installed metadata whose directory key does not match its structured identity', async () => {
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await expect(store.recordInstalled({ ...metadata, directoryKey: 'vp-wrong' }))
      .rejects.toThrow('voice_model_pack_directory_key_mismatch');
  });

  it('rejects duplicate durable installed identities instead of choosing one record by order', async () => {
    await writeFile(stateFilePath, JSON.stringify({
      schemaVersion: 1,
      accountId: 'account-a',
      machineId: 'machine-a',
      installed: [metadata, { ...metadata, packVersion: '2.0.0' }],
      licenseAcceptances: [],
    }), 'utf8');
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await expect(store.read()).rejects.toThrow('voice_model_pack_state_duplicate_identity');
  });

  it('invalidates acceptance by exact source, version, or license without removing its record', async () => {
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await store.acceptLicense({
      identity: metadata.identity,
      packVersion: metadata.packVersion,
      licenseId: 'Apache-2.0',
      ...licenseBinding,
      acceptedAtMs: 200,
    });
    await expect(store.findAcceptedLicense({
      identity: metadata.identity,
      packVersion: metadata.packVersion,
      licenseId: 'Apache-2.0',
      ...licenseBinding,
    })).resolves.toMatchObject({ acceptedAtMs: 200 });
    await expect(store.findAcceptedLicense({
      identity: metadata.identity,
      packVersion: '2.0.0',
      licenseId: 'Apache-2.0',
      ...licenseBinding,
    })).resolves.toBeUndefined();
    await expect(store.findAcceptedLicense({
      identity: metadata.identity,
      packVersion: metadata.packVersion,
      licenseId: 'Commercial-1',
      ...licenseBinding,
    })).resolves.toBeUndefined();
    await expect(store.findAcceptedLicense({
      identity: metadata.identity,
      packVersion: metadata.packVersion,
      licenseId: 'Apache-2.0',
      ...licenseBinding,
      artifactDigest: `sha256:${'d'.repeat(64)}`,
    })).resolves.toBeUndefined();
    expect((await store.read()).licenseAcceptances).toHaveLength(1);
  });

  it('removes installed metadata by structured identity and keeps that removal after restart', async () => {
    const store = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await store.recordInstalled(metadata);

    await expect(store.removeInstalled(metadata.identity)).resolves.toBe(true);
    await expect(store.removeInstalled(metadata.identity)).resolves.toBe(false);

    const restarted = createDaemonPublicVoiceModelPackStateStore({
      stateFilePath,
      accountId: 'account-a',
      machineId: 'machine-a',
    });
    await expect(restarted.read()).resolves.toMatchObject({ installed: [] });
  });
});
