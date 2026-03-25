import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createWorkspaceReplicationPaths } from '../state/workspaceReplicationPaths';

import { listWorkspaceReplicationJobs } from './listWorkspaceReplicationJobs';

describe('listWorkspaceReplicationJobs', () => {
    it('fails closed for legacy job records missing schemaVersion (no undeployed compatibility)', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-workspace-replication-list-jobs-'));

        try {
            const paths = createWorkspaceReplicationPaths({ activeServerDir });
            await mkdir(paths.jobsDirectory, { recursive: true });

            // Deliberately legacy-shaped record (missing schemaVersion).
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
            expect(jobs.map((job) => job.jobId)).not.toContain('job_legacy_1');
        } finally {
            await rm(activeServerDir, { recursive: true, force: true });
        }
    });
});
