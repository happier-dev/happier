import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createWorkspaceReplicationPaths } from '../state/workspaceReplicationPaths';

import { listWorkspaceReplicationJobs } from './listWorkspaceReplicationJobs';

describe('listWorkspaceReplicationJobs', () => {
    it('includes legacy job records that require normalization (phase/status mapping)', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-workspace-replication-list-jobs-'));

        try {
            const paths = createWorkspaceReplicationPaths({ activeServerDir });
            await mkdir(paths.jobsDirectory, { recursive: true });

            // This is a deliberately legacy-shaped record:
            // - status.status used to be 'running'
            // - status.phase used to be 'applying'
            const legacyRecord = {
                jobId: 'job_legacy_1',
                correlationId: 'corr_1',
                createdAtMs: 1,
                updatedAtMs: 2,
                status: {
                    status: 'running',
                    phase: 'applying',
                    checkpoint: 'job_created',
                },
            };

            await writeFile(
                join(paths.jobsDirectory, 'job_legacy_1.json'),
                JSON.stringify(legacyRecord),
                'utf8',
            );

            const jobs = await listWorkspaceReplicationJobs({ activeServerDir });
            expect(jobs.map((job) => job.jobId)).toContain('job_legacy_1');

            const job = jobs.find((j) => j.jobId === 'job_legacy_1');
            expect(job).toMatchObject({
                jobId: 'job_legacy_1',
                correlationId: 'corr_1',
                status: {
                    status: 'in_progress',
                    phase: 'apply',
                    checkpoint: 'job_created',
                },
            });
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });
});
