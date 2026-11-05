import { ForgeCiJobV1Schema, ForgeCiRunV1Schema } from '../../v1/index.js';

/** Native-shaped conformance vectors: attempts/steps are not universal facts. */
export function createForgeCiConformanceVectorsV1() {
    const githubRepository = { kind: 'github', deployment: 'https://github.com', repository: 'example/project' } as const;
    const gitlabRepository = { kind: 'gitlab', deployment: 'https://gitlab.com', repository: 'example/project' } as const;
    const githubRun = ForgeCiRunV1Schema.parse({ ref: { v: 1, repository: githubRepository, runId: '101' }, state: { phase: 'completed', outcome: 'failure', nativeLabel: 'failure', outcomeBucket: 'failed' } });
    const gitlabRun = ForgeCiRunV1Schema.parse({ ref: { v: 1, repository: gitlabRepository, runId: 'pipeline-42' }, state: { phase: 'completed', outcome: 'failure', nativeLabel: 'failed', outcomeBucket: 'failed' } });
    const githubJob = ForgeCiJobV1Schema.parse({ ref: { selection: { kind: 'attempt', attempt: { run: githubRun.ref, attemptId: '2', number: 2 } }, jobId: '202' }, name: 'Test (linux)', state: githubRun.state, steps: { kind: 'available', values: [{ id: 'step-7', number: 7, name: 'Test', state: githubRun.state }] } });
    const gitlabJob = ForgeCiJobV1Schema.parse({ ref: { selection: { kind: 'run', run: gitlabRun.ref }, jobId: 'job-99' }, name: 'Test', state: gitlabRun.state, steps: { kind: 'unsupported' } });
    return { github: { repository: githubRepository, run: githubRun, job: githubJob }, gitlab: { repository: gitlabRepository, run: gitlabRun, job: gitlabJob } };
}
