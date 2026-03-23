import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createSessionHandoffPrepareTargetJobStore } from './sessionHandoffPrepareTargetJobStore';

describe('sessionHandoffPrepareTargetJobStore', () => {
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
});
