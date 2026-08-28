import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createSessionHandoffPrepareTargetJobStore,
  recoverSessionHandoffPrepareTargetJobsAfterRestart,
} from './sessionHandoffPrepareTargetJobStore';

describe('sessionHandoffPrepareTargetJobStore', () => {
  it.each([
    ['target_identity_conflict', 'reconciliation_required'],
    ['agent_version_unsupported', 'failed'],
  ] as const)('durably preserves typed native-import failure %s', async (code, statusCode) => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-import-failure-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const handoffId = `handoff_${code}`;
      const jobId = `prepare_${code}`;
      await store.write({
        jobId,
        handoffId,
        createdAtMs: 1,
        updatedAtMs: 2,
        failedAtMs: 2,
        lastErrorMessage: 'Safe native import failure',
        status: {
          handoffId,
          jobId,
          status: statusCode,
          phase: 'staging_target',
          recoveryActions: [],
          failure: { code },
        },
      });

      await expect(store.read(jobId)).resolves.toMatchObject({
        failedAtMs: 2,
        status: {
          status: statusCode,
          failure: { code },
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when a persisted job file uses an unsupported schemaVersion', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-schema-'));
    try {
      const jobsDirectory = join(activeServerDir, 'session-handoff', 'prepare-target-jobs');
      await mkdir(jobsDirectory, { recursive: true });

      const jobId = 'prepare_job_schema_unsupported';
      await writeFile(join(jobsDirectory, `${jobId}.json`), JSON.stringify({
        schemaVersion: 2,
        jobId,
        handoffId: 'handoff_schema_unsupported',
        createdAtMs: 1,
        updatedAtMs: 1,
        status: {
          handoffId: 'handoff_schema_unsupported',
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
      }), 'utf8');

      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      await expect(store.read(jobId)).resolves.toBeNull();
      const entries = await readdir(jobsDirectory);
      expect(entries).toContain(`${jobId}.json`);
      expect(entries.filter((entry) => entry.startsWith(`${jobId}.json.invalid-`))).toHaveLength(0);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('quarantines a torn JSON job once while recovering valid jobs', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-corrupt-recovery-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const validJobId = 'prepare_valid_beside_corrupt';
      const validHandoffId = 'handoff_valid_beside_corrupt';
      await store.write({
        jobId: validJobId,
        handoffId: validHandoffId,
        createdAtMs: 10,
        updatedAtMs: 20,
        status: {
          handoffId: validHandoffId,
          jobId: validJobId,
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
        },
      });

      const jobsDirectory = join(activeServerDir, 'session-handoff', 'prepare-target-jobs');
      const corruptJobId = 'prepare_torn_json';
      const corruptBytes = '{"schemaVersion":1,"jobId":"prepare_torn_json"\0';
      await writeFile(join(jobsDirectory, `${corruptJobId}.json`), corruptBytes, 'utf8');

      await expect(recoverSessionHandoffPrepareTargetJobsAfterRestart({
        activeServerDir,
        nowMs: 30,
      })).resolves.toEqual({ deferredByLiveRunnerLease: false });
      await expect(store.read(validJobId)).resolves.toMatchObject({
        jobId: validJobId,
        status: { status: 'reconciliation_required' },
      });
      await expect(store.read(corruptJobId)).resolves.toBeNull();

      const afterFirstRecovery = await readdir(jobsDirectory);
      const quarantinedEntries = afterFirstRecovery.filter(
        (entry) => entry.startsWith(`${corruptJobId}.json.invalid-`),
      );
      expect(afterFirstRecovery).not.toContain(`${corruptJobId}.json`);
      expect(quarantinedEntries).toHaveLength(1);
      await expect(readFile(join(jobsDirectory, quarantinedEntries[0]!), 'utf8')).resolves.toBe(corruptBytes);

      await expect(recoverSessionHandoffPrepareTargetJobsAfterRestart({
        activeServerDir,
        nowMs: 40,
      })).resolves.toEqual({ deferredByLiveRunnerLease: false });
      expect(
        (await readdir(jobsDirectory)).filter(
          (entry) => entry.startsWith(`${corruptJobId}.json.invalid-`),
        ),
      ).toEqual(quarantinedEntries);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('serializes concurrent readers while quarantining one corrupt retained job', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-corrupt-readers-'));
    try {
      const jobsDirectory = join(activeServerDir, 'session-handoff', 'prepare-target-jobs');
      await mkdir(jobsDirectory, { recursive: true });
      const jobId = 'prepare_corrupt_concurrent_readers';
      await writeFile(join(jobsDirectory, `${jobId}.json`), '{"schemaVersion":1\0', 'utf8');
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });

      await expect(Promise.all([
        store.read(jobId),
        store.list(),
        store.findByHandoffId('handoff_missing'),
      ])).resolves.toEqual([null, [], null]);

      const entries = await readdir(jobsDirectory);
      expect(entries).not.toContain(`${jobId}.json`);
      expect(entries.filter((entry) => entry.startsWith(`${jobId}.json.invalid-`))).toHaveLength(1);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('fails closed when a persisted job file omits schemaVersion (no undeployed compatibility)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-legacy-'));
    try {
      const jobsDirectory = join(activeServerDir, 'session-handoff', 'prepare-target-jobs');
      await mkdir(jobsDirectory, { recursive: true });
      await writeFile(join(jobsDirectory, 'job_legacy_1.json'), JSON.stringify({
        // schemaVersion is intentionally omitted to prove we do not keep undeployed compatibility shims.
        jobId: 'job_legacy_1',
        handoffId: 'handoff_legacy_1',
        createdAtMs: 10,
        updatedAtMs: 10,
        status: {
          handoffId: 'handoff_legacy_1',
          status: 'in_progress',
          phase: 'preparing',
          recoveryActions: [],
        },
      }), 'utf8');

      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      await expect(store.read('job_legacy_1')).resolves.toBeNull();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('prefers the target prepare job over the source job when both share a handoffId', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-prefers-target-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const handoffId = 'handoff_prefers_target_1';

      await store.write({
        jobId: 'prepare_handoff_prefers_target_1',
        handoffId,
        createdAtMs: 10,
        updatedAtMs: 20,
        status: {
          handoffId,
          jobId: 'prepare_handoff_prefers_target_1',
          status: 'ready_for_cutover',
          phase: 'staging_target',
          transportStrategy: 'server_routed_stream',
          recoveryActions: [],
        },
        prepareTargetResult: {
          handoffId,
          status: {
            handoffId,
            jobId: 'prepare_handoff_prefers_target_1',
            status: 'ready_for_cutover',
            phase: 'staging_target',
            transportStrategy: 'server_routed_stream',
            recoveryActions: [],
          },
          remoteSessionId: 'session_target',
          directSource: {
            kind: 'claudeConfig',
            configDir: null,
            projectId: null,
          },
          resume: {
            directory: '/repo-target',
            agent: 'claude',
            resume: 'session_target',
            transcriptStorage: 'direct',
            approvedNewDirectoryCreation: true,
          },
        },
      });

      await store.write({
        jobId: 'source_handoff_prefers_target_1',
        handoffId,
        createdAtMs: 30,
        updatedAtMs: 40,
        status: {
          handoffId,
          jobId: 'source_handoff_prefers_target_1',
          status: 'completed',
          phase: 'finalizing',
          recoveryActions: [],
        },
      });

      await expect(store.findByHandoffId(handoffId)).resolves.toMatchObject({
        jobId: 'prepare_handoff_prefers_target_1',
        status: {
          status: 'ready_for_cutover',
        },
        prepareTargetResult: {
          status: {
            status: 'ready_for_cutover',
          },
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects incoherent records where the top-level handoffId disagrees with the status.handoffId', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-coherence-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      await expect(store.write({
        jobId: 'job_incoherent_1',
        handoffId: 'handoff_a',
        createdAtMs: 1,
        updatedAtMs: 1,
        status: {
          handoffId: 'handoff_b',
          status: 'pending',
          phase: 'preparing',
          recoveryActions: [],
        },
      })).rejects.toMatchObject({ name: 'ZodError' });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects incoherent records where status.jobId disagrees with the jobId (when provided)', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-coherence-jobid-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      await expect(store.write({
        jobId: 'job_incoherent_2',
        handoffId: 'handoff_jobid',
        createdAtMs: 1,
        updatedAtMs: 1,
        status: {
          handoffId: 'handoff_jobid',
          status: 'pending',
          phase: 'preparing',
          jobId: 'job_other',
          recoveryActions: [],
        },
      })).rejects.toMatchObject({ name: 'ZodError' });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('hydrates restart-recoverable pending jobs as awaiting explicit user Resume', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-recoverable-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const nowMs = Date.now();
      const jobId = 'job_recoverable_1';
      const handoffId = 'handoff_recoverable_1';

      await store.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 10_000,
        updatedAtMs: nowMs - 5_000,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
          progress: {
            updatedAtMs: nowMs - 5_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
        },
        prepareTargetRequest: {
          handoffId,
          sourceMachineId: 'machine_source',
          targetMachineId: 'machine_target',
          negotiatedTransportStrategy: 'direct_peer',
          sourceSessionStorageMode: 'persisted',
          targetPath: '/repo',
          endpointCandidates: [],
          handoffMetadataV2: {
            agentBundleTransferPublication: {
              transferId: `session-handoff:${handoffId}:provider-bundle`,
              sizeBytes: 123,
              manifestHash: 'hash',
              endpointCandidates: [
                { kind: 'http', url: 'http://127.0.0.1:1111', expiresAt: nowMs + 60_000, authorizationToken: 'tok' },
              ],
            },
          },
        },
      });

      await recoverSessionHandoffPrepareTargetJobsAfterRestart({
        activeServerDir,
        nowMs,
      });

      await expect(store.read(jobId)).resolves.toMatchObject({
        jobId,
        handoffId,
        status: {
          status: 'awaiting_user_resume',
          phase: 'staging_target',
          progress: {
            resumable: true,
            current: {
              phaseDetail: 'daemon_restart_awaiting_user_resume',
            },
          },
        },
        transitionRevision: 0,
        prepareRecovery: {
          status: 'awaiting_user_resume',
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('does not mark a prepare-target job awaiting_recovery while a live lease still exists on daemon startup', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-live-lease-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const nowMs = Date.now();
      const jobId = 'job_live_lease_1';
      const handoffId = 'handoff_live_lease_1';

      await store.write({
        jobId,
        handoffId,
        createdAtMs: nowMs - 10_000,
        updatedAtMs: nowMs - 5_000,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
          progress: {
            updatedAtMs: nowMs - 5_000,
            checkpoint: 'stage_target',
            planned: {},
            transferred: {},
            current: {
              phaseDetail: 'importing_workspace',
            },
            resumable: false,
          },
        },
      });

      const leaseDirectory = join(activeServerDir, 'session-handoff', 'prepare-target-jobs-staging', jobId, 'lease');
      await mkdir(leaseDirectory, { recursive: true });
      const liveLeaseRecord = {
        ownerId: `cli-daemon:${process.pid}:current`,
        acquiredAtMs: nowMs - 5_000,
        renewedAtMs: nowMs - 50,
        expiresAtMs: nowMs + 60_000,
      };
      await writeFile(join(leaseDirectory, 'lease.json'), JSON.stringify(liveLeaseRecord), 'utf8');
      await writeFile(join(leaseDirectory, 'runner.json'), JSON.stringify(liveLeaseRecord), 'utf8');

      await recoverSessionHandoffPrepareTargetJobsAfterRestart({
        activeServerDir,
        nowMs,
      });

      await expect(store.read(jobId)).resolves.toMatchObject({
        jobId,
        handoffId,
        status: {
          status: 'pending',
          phase: 'staging_target',
        },
      });
      await expect(store.read(jobId)).resolves.not.toMatchObject({
        status: {
          status: 'awaiting_recovery',
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('writes an interrupted v1 job forward once and fences explicit Resume by revision and attempt', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-resume-fence-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const jobId = 'prepare_resume_fence_1';
      const handoffId = 'handoff_resume_fence_1';
      await store.write({
        jobId,
        handoffId,
        createdAtMs: 10,
        updatedAtMs: 20,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
        },
        prepareTargetRequest: {
          handoffId,
          sourceMachineId: 'machine-source',
          targetMachineId: 'machine-target',
          negotiatedTransportStrategy: 'direct_peer',
          sourceSessionStorageMode: 'persisted',
          targetPath: '/repo',
          endpointCandidates: [],
        },
      });

      const hydrated = await store.hydrateInterrupted(jobId, 30);
      expect(hydrated).toMatchObject({
        schemaVersion: 2,
        recordKind: 'legacy_target',
        transitionRevision: 0,
        prepareRecovery: { status: 'awaiting_user_resume' },
        status: {
          status: 'awaiting_user_resume',
          progress: { resumable: true },
        },
      });

      const accepted = await store.acceptPrepareTargetResume({
        jobId,
        handoffId,
        expectedRevision: 0,
        attemptId: 'attempt-1',
        nowMs: 40,
      });
      expect(accepted).toMatchObject({
        ok: true,
        disposition: 'accepted',
        record: {
          transitionRevision: 1,
          prepareRecovery: {
            status: 'attempted',
            attemptId: 'attempt-1',
            acceptedRevision: 0,
          },
        },
      });

      await expect(store.acceptPrepareTargetResume({
        jobId,
        handoffId,
        expectedRevision: 0,
        attemptId: 'attempt-1',
        nowMs: 50,
      })).resolves.toMatchObject({
        ok: true,
        disposition: 'replay',
        record: { transitionRevision: 1 },
      });
      await expect(store.acceptPrepareTargetResume({
        jobId,
        handoffId,
        expectedRevision: 1,
        attemptId: 'attempt-1',
        nowMs: 50,
      })).resolves.toEqual({ ok: false, errorCode: 'stale_revision' });
      await expect(store.acceptPrepareTargetResume({
        jobId,
        handoffId,
        expectedRevision: 0,
        attemptId: 'attempt-2',
        nowMs: 50,
      })).resolves.toEqual({ ok: false, errorCode: 'attempt_conflict' });
      await expect(store.acceptPrepareTargetResume({
        jobId,
        handoffId,
        expectedRevision: 99,
        attemptId: 'attempt-1',
        nowMs: 50,
      })).resolves.toEqual({ ok: false, errorCode: 'stale_revision' });
      await expect(store.acceptPrepareTargetResume({
        jobId,
        handoffId: 'other-handoff',
        expectedRevision: 1,
        attemptId: 'attempt-1',
        nowMs: 50,
      })).resolves.toEqual({ ok: false, errorCode: 'identity_conflict' });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('reads a ready prospective predecessor v2 record without replacing its transition or runtime-Resume owners', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-predecessor-v2-'));
    try {
      const jobsDirectory = join(activeServerDir, 'session-handoff', 'prepare-target-jobs');
      const jobId = 'prepare_predecessor_v2_1';
      const handoffId = 'handoff_predecessor_v2_1';
      await mkdir(jobsDirectory, { recursive: true });
      const jobPath = join(jobsDirectory, `${jobId}.json`);
      await writeFile(jobPath, JSON.stringify({
        schemaVersion: 2,
        recordKind: 'prepared_target',
        jobId,
        handoffId,
        sessionId: 'session-predecessor-v2-1',
        createdAtMs: 10,
        updatedAtMs: 20,
        status: {
          handoffId,
          jobId,
          status: 'ready_for_cutover',
          phase: 'cutover',
          recoveryActions: [],
        },
        prepareTargetRequest: {
          handoffId,
          sourceMachineId: 'machine-source',
          targetMachineId: 'machine-target',
          negotiatedTransportStrategy: 'direct_peer',
          sourceSessionStorageMode: 'persisted',
          targetPath: '/repo',
          endpointCandidates: [],
          handoffMetadataV2: {
            providerBundleTransferPublication: {
              transferId: `session-handoff:${handoffId}:provider-bundle`,
              sizeBytes: 123,
              manifestHash: 'sha256:predecessor-manifest',
              endpointCandidates: [],
            },
          },
        },
        prepareTargetResult: {
          handoffId,
          status: {
            handoffId,
            jobId,
            status: 'ready_for_cutover',
            phase: 'cutover',
            recoveryActions: [],
          },
          remoteSessionId: 'claude-session-predecessor-v2',
          directSource: {
            kind: 'claudeConfig',
            configDir: null,
            projectId: null,
          },
          resume: {
            directory: '/repo',
            agent: 'claude',
            resume: 'claude-session-predecessor-v2',
            transcriptStorage: 'direct',
            approvedNewDirectoryCreation: true,
          },
        },
        transitionRevision: 3,
        resume: {
          status: 'attempted',
          attemptId: 'predecessor-runtime-attempt-1',
          acceptedAtMs: 19,
        },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
      }), 'utf8');

      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const predecessorBytes = await readFile(jobPath);
      const parsed = await store.read(jobId);
      expect(parsed).toMatchObject({
        recordKind: 'prepared_target',
        status: { status: 'ready_for_cutover' },
        transitionRevision: 3,
        prepareRecovery: { status: 'not_attempted' },
        resume: {
          status: 'attempted',
          attemptId: 'predecessor-runtime-attempt-1',
        },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
        prepareTargetRequest: {
          handoffMetadataV2: {
            agentBundleTransferPublication: {
              transferId: `session-handoff:${handoffId}:provider-bundle`,
            },
          },
        },
        prepareTargetResult: {
          remoteSessionId: 'claude-session-predecessor-v2',
        },
      });
      expect(parsed?.prepareTargetRequest?.handoffMetadataV2).not.toHaveProperty(
        'providerBundleTransferPublication',
      );
      await expect(store.hydrateInterrupted(jobId, 30)).resolves.toMatchObject({
        schemaVersion: 2,
        recordKind: 'prepared_target',
        sessionId: 'session-predecessor-v2-1',
        transitionRevision: 3,
        prepareRecovery: { status: 'not_attempted' },
        resume: {
          status: 'attempted',
          attemptId: 'predecessor-runtime-attempt-1',
        },
        terminal: { status: 'open' },
        targetCleanup: { status: 'not_required' },
        status: { status: 'ready_for_cutover' },
      });
      expect(await readFile(jobPath)).toEqual(predecessorBytes);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('reads predecessor V2 cleanup-retry recovery actions through the current recovery owner', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-predecessor-cleanup-'));
    try {
      const jobsDirectory = join(activeServerDir, 'session-handoff', 'prepare-target-jobs');
      const jobId = 'prepare_predecessor_cleanup_1';
      const handoffId = 'handoff_predecessor_cleanup_1';
      await mkdir(jobsDirectory, { recursive: true });
      const jobPath = join(jobsDirectory, `${jobId}.json`);
      await writeFile(jobPath, JSON.stringify({
        schemaVersion: 2,
        recordKind: 'prepared_target',
        jobId,
        handoffId,
        sessionId: 'session-predecessor-cleanup-1',
        createdAtMs: 10,
        updatedAtMs: 20,
        status: {
          handoffId,
          jobId,
          status: 'awaiting_recovery',
          phase: 'cutover',
          recoveryActions: ['retry_target_cleanup', 'keep_stopped'],
        },
        prepareTargetResult: {
          handoffId,
          status: {
            handoffId,
            jobId,
            status: 'ready_for_cutover',
            phase: 'cutover',
            recoveryActions: [],
          },
          remoteSessionId: 'claude-session-predecessor-cleanup',
          directSource: {
            kind: 'claudeConfig',
            configDir: null,
            projectId: null,
          },
          resume: {
            directory: '/repo',
            agent: 'claude',
            resume: 'claude-session-predecessor-cleanup',
            transcriptStorage: 'direct',
            approvedNewDirectoryCreation: true,
          },
        },
        transitionRevision: 4,
        resume: {
          status: 'attempted',
          attemptId: 'predecessor-runtime-attempt-cleanup',
          acceptedAtMs: 19,
        },
        terminal: {
          status: 'aborting',
          operationId: 'abort-predecessor-cleanup',
          claimedRevision: 4,
        },
        targetCleanup: {
          status: 'failed',
          reason: 'failed',
          attemptedAtMs: 20,
        },
      }), 'utf8');

      const predecessorBytes = await readFile(jobPath);
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      await expect(store.read(jobId)).resolves.toMatchObject({
        schemaVersion: 2,
        recordKind: 'prepared_target',
        status: {
          status: 'awaiting_recovery',
          recoveryActions: ['keep_stopped'],
        },
        terminal: {
          status: 'aborting',
          operationId: 'abort-predecessor-cleanup',
        },
        targetCleanup: {
          status: 'failed',
        },
      });
      expect(await readFile(jobPath)).toEqual(predecessorBytes);
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('serializes concurrent Resume attempts so only one transition wins', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-resume-race-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const jobId = 'prepare_resume_race_1';
      const handoffId = 'handoff_resume_race_1';
      await store.write({
        jobId,
        handoffId,
        createdAtMs: 10,
        updatedAtMs: 20,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
        },
        prepareTargetRequest: {
          handoffId,
          sourceMachineId: 'machine-source',
          targetMachineId: 'machine-target',
          negotiatedTransportStrategy: 'direct_peer',
          sourceSessionStorageMode: 'persisted',
          targetPath: '/repo',
          endpointCandidates: [],
        },
      });
      await store.hydrateInterrupted(jobId, 30);

      const results = await Promise.all([
        store.acceptPrepareTargetResume({
          jobId,
          handoffId,
          expectedRevision: 0,
          attemptId: 'attempt-a',
          nowMs: 40,
        }),
        store.acceptPrepareTargetResume({
          jobId,
          handoffId,
          expectedRevision: 0,
          attemptId: 'attempt-b',
          nowMs: 40,
        }),
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        { ok: false, errorCode: 'attempt_conflict' },
      ]);
      await expect(store.read(jobId)).resolves.toMatchObject({
        transitionRevision: 1,
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('keeps the persisted prepare-target semantic request immutable after interruption hydration', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-request-immutable-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const jobId = 'prepare_request_immutable_1';
      const handoffId = 'handoff_request_immutable_1';
      const originalRequest = {
        handoffId,
        sourceMachineId: 'machine-source',
        targetMachineId: 'machine-target',
        negotiatedTransportStrategy: 'direct_peer' as const,
        sourceSessionStorageMode: 'persisted' as const,
        targetPath: '/repo-original',
        endpointCandidates: [],
      };
      const status = {
        handoffId,
        jobId,
        status: 'pending' as const,
        phase: 'staging_target' as const,
        recoveryActions: [],
      };
      await store.write({
        jobId,
        handoffId,
        createdAtMs: 10,
        updatedAtMs: 20,
        status,
        prepareTargetRequest: originalRequest,
      });
      await store.hydrateInterrupted(jobId, 30);

      await expect(store.write({
        jobId,
        handoffId,
        createdAtMs: 10,
        updatedAtMs: 40,
        status,
        prepareTargetRequest: {
          ...originalRequest,
          targetPath: '/repo-relinked',
        },
      })).rejects.toThrow('semantic request is immutable');

      await expect(store.read(jobId)).resolves.toMatchObject({
        transitionRevision: 0,
        prepareTargetRequest: {
          targetPath: '/repo-original',
        },
        prepareRecovery: {
          status: 'awaiting_user_resume',
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('rejects a requested job id whose durable file contains a different job identity before acceptance', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-job-identity-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const persistedJobId = 'prepare_persisted_identity_1';
      const requestedJobId = 'prepare_requested_identity_1';
      const handoffId = 'handoff_job_identity_1';
      await store.write({
        jobId: persistedJobId,
        handoffId,
        createdAtMs: 10,
        updatedAtMs: 20,
        status: {
          handoffId,
          jobId: persistedJobId,
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
        },
        prepareTargetRequest: {
          handoffId,
          sourceMachineId: 'machine-source',
          targetMachineId: 'machine-target',
          negotiatedTransportStrategy: 'direct_peer',
          sourceSessionStorageMode: 'persisted',
          targetPath: '/repo',
          endpointCandidates: [],
        },
      });
      await store.hydrateInterrupted(persistedJobId, 30);

      const jobsDirectory = join(activeServerDir, 'session-handoff', 'prepare-target-jobs');
      const persistedBytes = await readFile(join(jobsDirectory, `${persistedJobId}.json`), 'utf8');
      await writeFile(join(jobsDirectory, `${requestedJobId}.json`), persistedBytes, 'utf8');

      await expect(store.acceptPrepareTargetResume({
        jobId: requestedJobId,
        handoffId,
        expectedRevision: 0,
        attemptId: 'attempt-mismatched-job',
        nowMs: 40,
      })).resolves.toEqual({ ok: false, errorCode: 'identity_conflict' });
      await expect(store.read(requestedJobId)).resolves.toMatchObject({
        jobId: persistedJobId,
        transitionRevision: 0,
        prepareRecovery: { status: 'awaiting_user_resume' },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('passively rehydrates a crash after Resume acceptance and rejoins only the original fenced attempt', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-resume-crash-rejoin-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const jobId = 'prepare_resume_crash_rejoin_1';
      const handoffId = 'handoff_resume_crash_rejoin_1';
      await store.write({
        jobId,
        handoffId,
        createdAtMs: 10,
        updatedAtMs: 20,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
        },
        prepareTargetRequest: {
          handoffId,
          sourceMachineId: 'machine-source',
          targetMachineId: 'machine-target',
          negotiatedTransportStrategy: 'direct_peer',
          sourceSessionStorageMode: 'persisted',
          targetPath: '/repo',
          endpointCandidates: [],
        },
      });
      await store.hydrateInterrupted(jobId, 30);
      await store.acceptPrepareTargetResume({
        jobId,
        handoffId,
        expectedRevision: 0,
        attemptId: 'attempt-original',
        nowMs: 40,
      });

      await recoverSessionHandoffPrepareTargetJobsAfterRestart({
        activeServerDir,
        nowMs: 50,
      });

      await expect(store.read(jobId)).resolves.toMatchObject({
        transitionRevision: 2,
        prepareRecovery: {
          status: 'awaiting_user_resume',
          interruptedAttempt: {
            attemptId: 'attempt-original',
            acceptedAtMs: 40,
            acceptedRevision: 0,
          },
        },
        status: {
          status: 'awaiting_user_resume',
          progress: { resumable: true },
        },
      });
      await recoverSessionHandoffPrepareTargetJobsAfterRestart({
        activeServerDir,
        nowMs: 55,
      });
      await expect(store.read(jobId)).resolves.toMatchObject({
        transitionRevision: 2,
        prepareRecovery: {
          status: 'awaiting_user_resume',
          interruptedAttempt: {
            attemptId: 'attempt-original',
            acceptedRevision: 0,
          },
        },
      });
      await expect(store.acceptPrepareTargetResume({
        jobId,
        handoffId,
        expectedRevision: 2,
        attemptId: 'attempt-original',
        nowMs: 60,
      })).resolves.toEqual({ ok: false, errorCode: 'stale_revision' });
      await expect(store.acceptPrepareTargetResume({
        jobId,
        handoffId,
        expectedRevision: 0,
        attemptId: 'attempt-original',
        nowMs: 60,
      })).resolves.toMatchObject({
        ok: true,
        disposition: 'replay',
        record: {
          transitionRevision: 3,
          prepareRecovery: {
            status: 'attempted',
            attemptId: 'attempt-original',
            acceptedRevision: 0,
          },
        },
      });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('allows one new current-revision attempt after a post-acceptance crash without reopening the old fence', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-handoff-prepare-resume-crash-new-attempt-'));
    try {
      const store = createSessionHandoffPrepareTargetJobStore({ activeServerDir });
      const jobId = 'prepare_resume_crash_new_attempt_1';
      const handoffId = 'handoff_resume_crash_new_attempt_1';
      await store.write({
        jobId,
        handoffId,
        createdAtMs: 10,
        updatedAtMs: 20,
        status: {
          handoffId,
          jobId,
          status: 'pending',
          phase: 'staging_target',
          recoveryActions: [],
        },
        prepareTargetRequest: {
          handoffId,
          sourceMachineId: 'machine-source',
          targetMachineId: 'machine-target',
          negotiatedTransportStrategy: 'direct_peer',
          sourceSessionStorageMode: 'persisted',
          targetPath: '/repo',
          endpointCandidates: [],
        },
      });
      await store.hydrateInterrupted(jobId, 30);
      await store.acceptPrepareTargetResume({
        jobId,
        handoffId,
        expectedRevision: 0,
        attemptId: 'attempt-lost-with-client',
        nowMs: 40,
      });
      await recoverSessionHandoffPrepareTargetJobsAfterRestart({
        activeServerDir,
        nowMs: 50,
      });

      await expect(store.acceptPrepareTargetResume({
        jobId,
        handoffId,
        expectedRevision: 2,
        attemptId: 'attempt-replacement',
        nowMs: 60,
      })).resolves.toMatchObject({
        ok: true,
        disposition: 'accepted',
        record: {
          transitionRevision: 3,
          prepareRecovery: {
            status: 'attempted',
            attemptId: 'attempt-replacement',
            acceptedRevision: 2,
          },
        },
      });
      await expect(store.acceptPrepareTargetResume({
        jobId,
        handoffId,
        expectedRevision: 0,
        attemptId: 'attempt-lost-with-client',
        nowMs: 70,
      })).resolves.toEqual({ ok: false, errorCode: 'attempt_conflict' });
      await expect(store.acceptPrepareTargetResume({
        jobId,
        handoffId,
        expectedRevision: 2,
        attemptId: 'another-client',
        nowMs: 70,
      })).resolves.toEqual({ ok: false, errorCode: 'attempt_conflict' });
    } finally {
      await rm(activeServerDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
