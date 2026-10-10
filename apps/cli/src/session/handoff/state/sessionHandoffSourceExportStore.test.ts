import { mkdtemp, mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { SessionHandoffAgentBundle } from '../types';
import { readSessionHandoffAgentBundleFile } from '../agentBundle/file';
import { createSessionHandoffSourceExportStore } from './sessionHandoffSourceExportStore';
import { createSessionHandoffStatusGetActionHandler } from '@/api/machine/sessionHandoff/statusGet';
import { createSessionHandoffPrepareTargetJobStore } from '../prepare/sessionHandoffPrepareTargetJobStore';
import { buildStartPendingStatus, invalidRequest, readPersistedPrepareJob } from '@/api/machine/sessionHandoff/prepareTargetState';
import { createRequesterSessionCredentialCustody, requesterSessionCredentialPath } from '@/daemon/sessionEncryption/requesterSessionCredentials';

describe('sessionHandoffSourceExportStore', () => {
  it('holds the existing requester credential reference until export release without copying its bearer', async () => {
    const happyHomeDir = await mkdtemp(join(os.tmpdir(), 'happier-handoff-existing-custody-'));
    try {
      const binding = { happyHomeDir, sessionId: 'same-session', attribution: { serverId: 'home', accountId: 'bob',
        machineId: 'source', installationId: 'source-installation' } };
      await createRequesterSessionCredentialCustody({ ...binding, credentials: { token: 'existing-bob-bearer', encryption: null } });
      const activeServerDir = join(happyHomeDir, 'active-server');
      const store = createSessionHandoffSourceExportStore({ activeServerDir, happyHomeDir });
      await Reflect.apply(store.save, store, [{ handoffId: 'handoff-custody', sessionId: binding.sessionId,
        sourceMachineId: 'source', targetMachineId: 'target', exportedAtMs: 1,
        requesterSessionCredentialBinding: { sessionId: binding.sessionId, attribution: binding.attribution } }]);
      const record = await store.load('handoff-custody');
      expect(record).toMatchObject({ requesterSessionCredentialBinding: { sessionId: binding.sessionId, attribution: binding.attribution } });
      expect(JSON.stringify(record)).not.toContain('existing-bob-bearer');
      expect((await stat(requesterSessionCredentialPath(binding))).isFile()).toBe(true);
      await createSessionHandoffSourceExportStore({ activeServerDir, happyHomeDir }).releaseTransferFiles('handoff-custody');
      await expect(stat(requesterSessionCredentialPath(binding))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await store.load('handoff-custody')).not.toHaveProperty('requesterSessionCredentialBinding');
      const targetBinding = { ...binding, attribution: { ...binding.attribution, machineId: 'target', installationId: 'target-installation' } };
      await createRequesterSessionCredentialCustody({ ...targetBinding, credentials: { token: 'existing-target-bearer', encryption: null } });
      await store.save({ handoffId: 'handoff-target', sessionId: targetBinding.sessionId, sourceMachineId: 'source',
        targetMachineId: 'target', exportedAtMs: 2,
        requesterSessionCredentialBinding: { sessionId: targetBinding.sessionId, attribution: targetBinding.attribution } });
      await store.releaseTransferFiles('handoff-target', { preserveRequesterSessionCustody: true });
      expect((await stat(requesterSessionCredentialPath(targetBinding))).isFile()).toBe(true);
      expect(await store.load('handoff-target')).not.toHaveProperty('requesterSessionCredentialBinding');
    } finally { await rm(happyHomeDir, { recursive: true, force: true }); }
  });
  it('retains the exact accepted root proof across export publication and cold reads without disclosing it in status', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-handoff-root-custody-'));
    try {
      const store = createSessionHandoffSourceExportStore({ activeServerDir });
      const rootAuthorization = { v: 1, token: 'home-signed-original-handoff-secret', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_home',
        machineId: 'source', custodianAccountId: 'alice', installationId: 'source-installation',
        actionId: 'session.handoff', requestId: 'root-request', requestEnvelopeDigest: 'a'.repeat(43),
        target: { kind: 'machine', machineId: 'source' },
        handoffAdmission: { sessionId: 'same-session', sourceMachineId: 'source', targetMachineId: 'target',
          sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
      } };
      const accepted = { handoffId: 'handoff-root', sessionId: 'same-session', sourceMachineId: 'source',
        targetMachineId: 'target', exportedAtMs: 1, acceptedHandoffAuthorization: rootAuthorization };
      // The persisted proof is custody data; only the Home verifier can admit it as authority.
      await Reflect.apply(store.save, store, [accepted]);
      await store.save({ handoffId: accepted.handoffId, sessionId: accepted.sessionId,
        sourceMachineId: accepted.sourceMachineId, targetMachineId: accepted.targetMachineId, exportedAtMs: 2 });
      const recovered = createSessionHandoffSourceExportStore({ activeServerDir });
      expect(await recovered.load(accepted.handoffId)).toMatchObject({ acceptedHandoffAuthorization: rootAuthorization });
      const status = createSessionHandoffStatusGetActionHandler({ sourceExportStore: recovered,
        prepareJobStore: createSessionHandoffPrepareTargetJobStore({ activeServerDir }),
        readPersistedPrepareJob, buildStartPendingStatus, invalidRequest });
      expect(JSON.stringify(await status({ handoffId: accepted.handoffId }))).not.toContain(rootAuthorization.token);
      await expect(recovered.save({ handoffId: accepted.handoffId, sessionId: 'different-session',
        sourceMachineId: accepted.sourceMachineId, targetMachineId: accepted.targetMachineId, exportedAtMs: 3 })).rejects.toThrow();
      expect(await recovered.load(accepted.handoffId)).toMatchObject({ sessionId: accepted.sessionId,
        acceptedHandoffAuthorization: rootAuthorization });
    } finally { await rm(activeServerDir, { recursive: true, force: true }); }
  });

  it('saves and loads a schema-versioned source export record', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-store-'));
    try {
      const store = createSessionHandoffSourceExportStore({ activeServerDir });
      await store.save({
        handoffId: 'handoff-123',
        exportedAtMs: 1234,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        agentBundle: {
          transferId: 'session-handoff:handoff-123:provider-bundle-file',
          filePath: join(activeServerDir, 'dummy-provider.json'),
          sizeBytes: 2,
          manifestHash: `sha256:${'a'.repeat(64)}`,
        },
      });

      const loaded = await store.load('handoff-123');
      expect(loaded).toEqual(
        expect.objectContaining({
          handoffId: 'handoff-123',
          exportedAtMs: 1234,
          sourceMachineId: 'machine_source',
          targetMachineId: 'machine_target',
        }),
      );
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('writes provider bundle files under the handoff directory', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-store-files-'));
    try {
      const store = createSessionHandoffSourceExportStore({ activeServerDir });
      const handoffId = 'handoff-files-1';

      const provider = await store.writeAgentBundleFile({
        handoffId,
        agentBundle: {
          agentId: 'codex',
          remoteSessionId: 'remote-session-1',
          files: [],
        },
      });
      const providerStats = await stat(provider.filePath);
      expect(providerStats.isFile()).toBe(true);
      expect(provider.sizeBytes).toBe(providerStats.size);
      expect(provider.manifestHash.startsWith('sha256:')).toBe(true);
      const parsedProvider = await readSessionHandoffAgentBundleFile(provider.filePath);
      expect(parsedProvider).toMatchObject({ agentId: 'codex' });
      await expect(readSessionHandoffAgentBundleFile(provider.filePath)).resolves.toMatchObject({
        agentId: 'codex',
      });

    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('releases completed transfer payloads while preserving durable handoff metadata', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-store-release-'));
    try {
      const store = createSessionHandoffSourceExportStore({ activeServerDir });
      const handoffId = 'handoff-release-1';
      const agentBundle = await store.writeAgentBundleFile({
        handoffId,
        agentBundle: {
          agentId: 'codex',
          remoteSessionId: 'remote-session-release',
          files: [],
        },
      });
      const receivedBundlePath = await store.prepareReceivedAgentBundleFilePath(handoffId);
      await writeFile(receivedBundlePath, Buffer.from('received'));
      await store.save({
        handoffId,
        exportedAtMs: 1234,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        agentBundle,
      });

      await store.releaseTransferFiles(handoffId);

      await expect(stat(agentBundle.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(receivedBundlePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(store.load(handoffId)).resolves.toEqual(expect.objectContaining({
        handoffId,
        exportedAtMs: 1234,
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
      }));
      expect((await store.load(handoffId))?.agentBundle).toBeUndefined();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('persists referenced files as a portable binary artifact', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-store-binary-'));
    const sourceDirectory = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-store-source-'));
    try {
      const sourcePath = join(sourceDirectory, 'rollout.jsonl');
      const sourceContents = Buffer.alloc(5 * 1024 * 1024, 0x61);
      await writeFile(sourcePath, sourceContents);

      const store = createSessionHandoffSourceExportStore({ activeServerDir });
      const onProgress = vi.fn();
      const persisted = await store.writeAgentBundleFile({
        handoffId: 'handoff-binary-1',
        onProgress,
        agentBundle: {
          agentId: 'codex',
          remoteSessionId: 'remote-session-large',
          files: [{
            relativePath: 'sessions/rollout.jsonl',
            contentFile: {
              t: 'happier.handoff.file.v1',
              filePath: sourcePath,
              offsetBytes: 0,
              sizeBytes: sourceContents.length,
            },
          }],
        } satisfies SessionHandoffAgentBundle,
      });

      expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual(expect.arrayContaining([
        { currentBytes: 0, totalBytes: sourceContents.length },
        { currentBytes: sourceContents.length, totalBytes: sourceContents.length },
      ]));

      expect(persisted.sizeBytes).toBeGreaterThan(sourceContents.length);
      expect(persisted.sizeBytes).toBeLessThan(sourceContents.length + 64 * 1024);

      const artifactFile = await open(persisted.filePath, 'r');
      try {
        const magic = Buffer.from('HAPPIER_SESSION_HANDOFF_BUNDLE_V2\n', 'utf8');
        const prefix = Buffer.alloc(magic.length);
        await artifactFile.read(prefix, 0, prefix.length, 0);
        expect(prefix.equals(magic)).toBe(true);
      } finally {
        await artifactFile.close();
      }

      const parsed = await readSessionHandoffAgentBundleFile(persisted.filePath);
      const contentFile = (parsed.files as Array<{ contentFile?: {
        filePath: string;
        offsetBytes: number;
        sizeBytes: number;
      } }>)[0]?.contentFile;
      expect(contentFile).toEqual(expect.objectContaining({
        filePath: persisted.filePath,
        sizeBytes: sourceContents.length,
      }));
      if (!contentFile) throw new Error('Expected a materialized handoff file');

      const rehydratedFile = await open(contentFile.filePath, 'r');
      try {
        const sample = Buffer.alloc(64);
        const { bytesRead } = await rehydratedFile.read(sample, 0, sample.length, contentFile.offsetBytes);
        expect(bytesRead).toBe(sample.length);
        expect(sample.equals(sourceContents.subarray(0, sample.length))).toBe(true);
      } finally {
        await rehydratedFile.close();
      }
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  });

  it('persists provider-owned bundle fields through the open handoff bundle ABI', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-store-bundle-shape-'));
    try {
      const store = createSessionHandoffSourceExportStore({ activeServerDir });
      const written = await store.writeAgentBundleFile({
        handoffId: 'handoff-bundle-shape-1',
        agentBundle: {
          agentId: 'opencode',
          remoteSessionId: 'remote-session-1',
          exportJsonBase64: Buffer.from('{}', 'utf8').toString('base64'),
          affinity: {
            backendMode: 'server',
            serverBaseUrl: null,
            serverBaseUrlExplicit: false,
          },
          providerOwnedField: {
            nested: true,
          },
        } as unknown as SessionHandoffAgentBundle,
      });

      await expect(readSessionHandoffAgentBundleFile(written.filePath)).resolves.toMatchObject({
        agentId: 'opencode',
        remoteSessionId: 'remote-session-1',
        providerOwnedField: {
          nested: true,
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed on invalid handoff ids that can escape the activeServerDir', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-store-safe-'));
    try {
      const store = createSessionHandoffSourceExportStore({ activeServerDir });
      await expect(store.load('../evil')).rejects.toThrow(/Invalid handoffId/);
      await expect(store.save({
        handoffId: '../evil',
        exportedAtMs: 1,
      })).rejects.toThrow(/Invalid handoffId/);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('fails closed when persisted file paths escape the activeServerDir', async () => {
    const activeServerDir = await mkdtemp(join(os.tmpdir(), 'happier-session-handoff-store-escape-'));
    try {
      const store = createSessionHandoffSourceExportStore({ activeServerDir });
      const handoffId = 'handoff-escape-1';
      const handoffDir = join(activeServerDir, 'session-handoff', handoffId);
      await mkdir(handoffDir, { recursive: true });

      await writeFile(join(handoffDir, 'source-export.json'), JSON.stringify({
        t: 'session_handoff_source_export_v1',
        schemaVersion: 1,
        handoffId,
        exportedAtMs: 1,
        agentBundle: {
          transferId: 'session-handoff:handoff-escape-1:provider-bundle-file',
          filePath: '../../outside-provider.json',
          sizeBytes: 1,
          manifestHash: `sha256:${'a'.repeat(64)}`,
        },
      }, null, 2) + '\n', 'utf8');

      await expect(store.load(handoffId)).rejects.toThrow('Invalid session handoff source export record');
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});
