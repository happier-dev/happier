import { describe, expect, it } from 'vitest';
import { ForgeCiStateV1Schema } from './state.js';
import { ForgeCiRunV1Schema } from './runs.js';
import { ForgeCiJobV1Schema } from './jobs.js';
import { ForgeCiActionInputSchemasV1, ForgeCiActionResultSchemasV1 } from './operations.js';
import { ForgeCiLogSelectionV1Schema, ForgeCiExcerptRequestV1Schema, ForgeCiLogV1Schema } from './logs.js';
import { ForgeCiMountedIntentInputV1Schema, ForgeCiMountedIntentResultV1Schema } from './mountedIntent.js';
import { ForgeCiSelectionV1Schema } from './identity.js';
import { ForgeCiTriggerDefinitionV1Schema, ForgeCiTriggerValuesV1Schema } from './triggers.js';
import { createForgeCiConformanceVectorsV1 } from '../testing/v1/index.js';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';

describe('CI executable V1 contract', () => {
    it('carries declared native step precision without changing the native endpoints', () => {
        const job = createForgeCiConformanceVectorsV1().github.job;
        if (job.steps.kind !== 'available') throw new Error('Conformance job must include steps');
        const value = { ...job, steps: { kind: 'available', values: job.steps.values.map(step => ({ ...step, timestampPrecision: 'second' })) } };
        expect(ForgeCiJobV1Schema.parse(value)).toEqual(value);
        expect(ForgeCiJobV1Schema.safeParse({ ...value, steps: { kind: 'available', values: [{ ...value.steps.values[0], timestampPrecision: 'minute' }] } }).success).toBe(false);
    });

    it('carries a native run update separately from completion through exact read results', () => {
        const run = { ...createForgeCiConformanceVectorsV1().github.run, startedAtMs: 1000, updatedAtMs: 19000 };
        expect(ForgeCiActionResultSchemasV1.readRun.parse({ kind: 'value', value: run })).toEqual({ kind: 'value', value: run });
        expect(ForgeCiRunV1Schema.parse(run)).not.toHaveProperty('completedAtMs');
        expect(ForgeCiRunV1Schema.safeParse({ ...run, updatedAtMs: -1 }).success).toBe(false);
        expect(ForgeCiRunV1Schema.parse(createForgeCiConformanceVectorsV1().github.run)).not.toHaveProperty('updatedAtMs');
    });

    it('accepts the exact configured Account on reads and deployment reviews without replacing native absence', () => {
        const { repository, run } = createForgeCiConformanceVectorsV1().github;
        const credentialRef = QualifiedConnectedAccountRefSchema.parse({
            service: { pluginId: 'example.forge', localId: 'account' }, accountId: 'configured-account',
        });
        const inputs = {
            listWorkflows: { repository },
            readWorkflow: { repository, workflowId: 'workflow' },
            listRuns: { repository, filters: {} },
            readRun: { repository, runId: 'run' },
            listJobs: { repository, runId: 'run' },
            readJob: { repository, jobId: 'job' },
            readJobLog: { repository, runId: 'run', jobId: 'job', selection: { kind: 'all' } },
            listArtifacts: { repository, runId: 'run' },
            listAnnotations: { repository, runId: 'run', jobId: 'job', checkRunId: 'check' },
            readTrigger: { repository, workflowId: 'workflow', ref: 'main' },
            listEnvironments: { repository },
            listDeployments: { repository, runId: 'run' },
            readDeploymentHistory: { repository, runId: 'run' },
            readFailureContext: { repository, selection: { kind: 'run', run: run.ref },
                excerpt: { contextLines: 0, tailLines: 0, failedOnly: false }, maxSerializedBytes: 1024 },
            approveDeployment: { repository, runId: 'run', environmentIds: ['environment'], comment: '' },
            rejectDeployment: { repository, runId: 'run', environmentIds: ['environment'], comment: '' },
        };
        for (const operation of Object.keys(inputs) as (keyof typeof inputs)[]) {
            const input = inputs[operation];
            const schema = ForgeCiActionInputSchemasV1[operation];
            expect(schema.parse(input), operation).toEqual(input);
            expect(schema.safeParse({ ...input, credentialRef }).success, operation).toBe(true);
            expect(schema.parse({ ...input, credentialRef }), operation).toEqual({ ...input, credentialRef });
            expect(schema.parse({ ...input, credentialRef: null }), operation).toEqual({ ...input, credentialRef: null });
            for (const malformed of ['configured-account', { accountId: 'configured-account' },
                { ...credentialRef, accountId: '' }, { ...credentialRef, token: 'not-an-operand' }]) {
                expect(schema.safeParse({ ...input, credentialRef: malformed }).success, operation).toBe(false);
            }
        }
        // This approved slice does not silently widen unrelated effect inputs.
        expect(ForgeCiActionInputSchemasV1.dispatchWorkflow.safeParse({ repository,
            workflowId: 'workflow', ref: 'main', inputs: {}, credentialRef }).success).toBe(false);
    });

    it('preserves provider startup failure and stale outcomes', () => {
        expect(ForgeCiStateV1Schema.parse({ phase: 'completed', outcome: 'startup_failure', nativeLabel: 'startup_failure', outcomeBucket: 'failed' }).outcome).toBe('startup_failure');
        expect(ForgeCiStateV1Schema.parse({ phase: 'completed', outcome: 'stale', nativeLabel: 'stale', outcomeBucket: 'neutral' }).outcome).toBe('stale');
    });

    it('does not turn terminal outcomes into nonterminal state', () => {
        expect(ForgeCiStateV1Schema.parse({ phase: 'running', outcome: null, nativeLabel: 'running', outcomeBucket: 'pending' })).toMatchObject({ phase: 'running', outcome: null });
        expect(ForgeCiStateV1Schema.safeParse({ phase: 'running', outcome: 'success', nativeLabel: 'running', outcomeBucket: 'pending' }).success).toBe(false);
    });

    it('retains native attempt selection while accepting no-attempt and no-step providers', () => {
        const vectors = createForgeCiConformanceVectorsV1();
        expect(vectors.github.job.ref.selection).toEqual({ kind: 'attempt', attempt: { run: vectors.github.run.ref, attemptId: '2', number: 2 } });
        expect(vectors.gitlab.job.steps.kind).toBe('unsupported');
        expect(ForgeCiSelectionV1Schema.safeParse({ kind: 'run', run: vectors.github.run.ref, attempt: { run: vectors.github.run.ref, attemptId: '2' } }).success).toBe(false);
        // Native run rows can prove workflow identity without a workflow metadata read.
        expect(ForgeCiRunV1Schema.parse({ ...vectors.github.run, workflow: { id: 'workflow-1' } }).workflow?.id).toBe('workflow-1');
    });

    it('retains observed fork approval provenance without promoting generic waiting or missing facts', () => {
        const run = createForgeCiConformanceVectorsV1().github.run;
        const headSha = 'b'.repeat(40);
        const forkApproval = {
            required: true,
            contributor: 'contributor-handle',
            sourceRepository: { ...run.ref.repository, repository: 'contributor/project' },
        };
        expect(ForgeCiRunV1Schema.parse({ ...run, headSha, forkApproval })).toMatchObject({ headSha, forkApproval });
        expect(ForgeCiRunV1Schema.parse({ ...run, forkApproval: { required: false } })).toHaveProperty('forkApproval.required', false);
        expect(ForgeCiRunV1Schema.parse({ ...run, forkApproval: { required: true } })).toHaveProperty('forkApproval.required', true);
        const waiting = ForgeCiRunV1Schema.parse({ ...run, state: { phase: 'waiting', outcome: null, nativeLabel: 'waiting', outcomeBucket: 'pending' } });
        expect(waiting).not.toHaveProperty('forkApproval');
        expect(waiting).not.toHaveProperty('headSha');
        expect(ForgeCiRunV1Schema.safeParse({ ...run, forkApproval: { required: 'true' } }).success).toBe(false);
        expect(ForgeCiRunV1Schema.safeParse({ ...run, forkApproval: { ...forkApproval, permission: 'approve' } }).success).toBe(false);
    });

    it('requires the exact reviewed fork facts as executable approval operands', () => {
        const { run } = createForgeCiConformanceVectorsV1().github;
        const target = { repository: run.ref.repository, runId: run.ref.runId, attempt: '2' };
        const reviewed = { headSha: 'b'.repeat(40), contributor: 'contributor-handle',
            sourceRepository: { ...run.ref.repository, repository: 'contributor/project' } };
        expect(ForgeCiActionInputSchemasV1.approveForkRun.parse({ ...target, ...reviewed })).toEqual({ ...target, ...reviewed });
        expect(ForgeCiActionInputSchemasV1.approveForkRun.safeParse(target).success).toBe(false);
        for (const key of ['headSha', 'contributor', 'sourceRepository'] as const) {
            const missing = { ...target, ...reviewed };
            Reflect.deleteProperty(missing, key);
            expect(ForgeCiActionInputSchemasV1.approveForkRun.safeParse(missing).success).toBe(false);
        }
        expect(ForgeCiActionInputSchemasV1.approveForkRun.safeParse({ ...target, ...reviewed, headSha: '' }).success).toBe(false);
    });

    it('carries parsed workflow dependency facts through the existing trigger read without inventing graph coverage', () => {
        const definition = { workflowId: 'workflow-1', ref: 'topic', revision: 'c'.repeat(40), inputs: [], dispatchable: true };
        const jobs = [
            { id: 'build', needs: [], runsOn: ['self-hosted', 'linux'] },
            { id: 'test', needs: ['build'], runsOn: ['ubuntu-latest'] },
            { id: 'ship', needs: ['build', 'test'], runsOn: 'dynamic' },
        ];
        expect(ForgeCiTriggerDefinitionV1Schema.parse({ ...definition, jobs })).toMatchObject({ jobs });
        expect(ForgeCiActionResultSchemasV1.readTrigger.parse({ kind: 'value', value: { ...definition, jobs } })).toMatchObject({ kind: 'value', value: { jobs } });
        expect(ForgeCiTriggerDefinitionV1Schema.parse(definition)).not.toHaveProperty('jobs');
        expect(ForgeCiTriggerDefinitionV1Schema.parse({ ...definition, jobs: [] })).toHaveProperty('jobs', []);
        expect(ForgeCiTriggerDefinitionV1Schema.safeParse({ ...definition, jobs: [{ id: 'test', needs: ['build'], runsOn: { expression: 'runner' } }] }).success).toBe(false);
        expect(ForgeCiTriggerDefinitionV1Schema.safeParse({ ...definition, jobs: [{ id: 'test', needs: [7], runsOn: [] }] }).success).toBe(false);
        expect(createForgeCiConformanceVectorsV1().gitlab.job.steps.kind).toBe('unsupported');
    });

    it('preserves explicit false, exact filter keys, zero excerpts and native step selections', () => {
        const repository = createForgeCiConformanceVectorsV1().github.repository;
        expect(ForgeCiActionInputSchemasV1.listRuns.parse({ repository, filters: { created: '>=2026-10-01', excludePullRequests: false, checkSuiteId: 'suite-1' }, validator: 'etag' }).filters).toEqual({ created: '>=2026-10-01', excludePullRequests: false, checkSuiteId: 'suite-1' });
        expect(ForgeCiExcerptRequestV1Schema.parse({ contextLines: 0, tailLines: 0, failedOnly: false })).toEqual({ contextLines: 0, tailLines: 0, failedOnly: false });
        expect(ForgeCiLogSelectionV1Schema.parse({ kind: 'steps', stepIds: ['native:7', 'native:11'] })).toEqual({ kind: 'steps', stepIds: ['native:7', 'native:11'] });
        for (const input of [{ kind: 'tail', lines: 0 }, { kind: 'steps', stepIds: [] }, { kind: 'steps', stepIds: ['a', 'a'] }, { kind: 'all', lines: 5 }]) expect(ForgeCiLogSelectionV1Schema.safeParse(input).success).toBe(false);
        expect(ForgeCiTriggerValuesV1Schema.parse({ 'a.b': false, zero: 0 })).toEqual({ 'a.b': false, zero: 0 });
        const nativeKeys: unknown = JSON.parse('{"__proto__":false,"constructor":0,"a.b":"value"}');
        const values = ForgeCiTriggerValuesV1Schema.parse(nativeKeys);
        expect(Object.hasOwn(values, '__proto__')).toBe(true);
        expect(values['__proto__']).toBe(false);
        expect(values['constructor']).toBe(0);
        expect(ForgeCiTriggerValuesV1Schema.safeParse({ value: Infinity }).success).toBe(false);
    });

    it('requires producer-supplied failure-context operands while preserving explicit selections and budgets', () => {
        const { repository, run } = createForgeCiConformanceVectorsV1().github;
        const input = { repository, selection: { kind: 'run', run: run.ref } };
        expect(ForgeCiActionInputSchemasV1.readFailureContext.safeParse(input).success).toBe(false);
        const explicit = { ...input, jobs: ['native-job'], excerpt: { contextLines: 0, tailLines: 0, failedOnly: false, stepIds: ['native-step'] }, maxSerializedBytes: 1 };
        expect(ForgeCiActionInputSchemasV1.readFailureContext.parse(explicit)).toEqual(explicit);
        expect(ForgeCiActionInputSchemasV1.readFailureContext.safeParse({ ...input, maxSerializedBytes: 0 }).success).toBe(false);
        expect(ForgeCiActionInputSchemasV1.readFailureContext.safeParse({ ...input, limit: 200 }).success).toBe(false);
    });

    it('keeps pending and unsupported logs distinct from available original evidence', () => {
        const job = createForgeCiConformanceVectorsV1().github.job.ref;
        expect(ForgeCiLogV1Schema.parse({ kind: 'pending', job })).toEqual({ kind: 'pending', job });
        expect(ForgeCiLogV1Schema.safeParse({ kind: 'pending', job, text: '' }).success).toBe(false);
        const available = { kind: 'available', job, logId: 'native-log-1', startLine: 21, startByte: 300, complete: false, continuation: 'provider-cursor' };
        expect(ForgeCiLogV1Schema.parse({ ...available, text: 'original text' })).toMatchObject({ startLine: 21, startByte: 300, text: 'original text', complete: false });
        expect(ForgeCiLogV1Schema.safeParse({ ...available, text: '', fragments: [] }).success).toBe(false);
        expect(ForgeCiLogV1Schema.safeParse({ ...available, fragments: [{ text: 'line', startLine: 0, startByte: 300 }] }).success).toBe(false);
    });

    it('native job lookup does not require a fabricated run and unsupported reads carry no values', () => {
        const repository = createForgeCiConformanceVectorsV1().github.repository;
        expect(ForgeCiActionInputSchemasV1.readJob.parse({ repository, jobId: 'job-1' })).toEqual({ repository, jobId: 'job-1' });
        expect(ForgeCiActionInputSchemasV1.readJob.safeParse({ repository, jobId: 'job-1', runId: 'run-1' }).success).toBe(false);
        const failure = { class: 'unsupportedContract', code: 'unsupported' };
        expect(ForgeCiActionResultSchemasV1.readRun.parse({ kind: 'unavailable', failure })).toEqual({ kind: 'unavailable', failure });
        expect(ForgeCiActionResultSchemasV1.readRun.safeParse({ kind: 'unavailable', failure, value: {} }).success).toBe(false);
        expect(ForgeCiActionResultSchemasV1.readJobLog.safeParse({ kind: 'notModified' }).success).toBe(false);
    });

    it('mounted operands use one closed addressed envelope without stale or read values on refusal', () => {
        expect(ForgeCiMountedIntentInputV1Schema.parse({ mountId: 'mount', operation: { kind: 'setTimestampsVisible', visible: false } })).toEqual({ mountId: 'mount', operation: { kind: 'setTimestampsVisible', visible: false } });
        expect(ForgeCiMountedIntentInputV1Schema.safeParse({ mountId: 'mount', intent: { kind: 'setTimestampsVisible', visible: false } }).success).toBe(false);
        expect(ForgeCiMountedIntentInputV1Schema.safeParse({ mountId: 'mount', operation: { kind: 'refresh' } }).success).toBe(false);
        expect(ForgeCiMountedIntentResultV1Schema.safeParse({ status: 'stale_surface' }).success).toBe(false);
        expect(ForgeCiMountedIntentResultV1Schema.safeParse({ status: 'unavailable', value: {} }).success).toBe(false);
    });

    it('binds both distinct remote effects and canonical receiver-only downloads', () => {
        expect(Object.keys(ForgeCiActionInputSchemasV1)).toEqual([
            'listWorkflows', 'readWorkflow', 'listRuns', 'readRun', 'listJobs',
            'readJob', 'readJobLog', 'listArtifacts', 'downloadArtifact',
            'listAnnotations', 'readTrigger', 'listEnvironments', 'downloadJobLog',
            'dispatchWorkflow', 'enableWorkflow', 'disableWorkflow', 'rerunAll',
            'rerunFailed', 'rerunJob', 'cancelRun', 'forceCancelRun', 'approveForkRun',
            'listDeployments', 'readDeploymentHistory', 'approveDeployment',
            'rejectDeployment', 'readFailureContext',
        ]);
        expect(Object.keys(ForgeCiActionResultSchemasV1)).toEqual(Object.keys(ForgeCiActionInputSchemasV1));
        expect(ForgeCiActionInputSchemasV1.enableWorkflow).toBe(ForgeCiActionInputSchemasV1.disableWorkflow);
        expect(ForgeCiActionInputSchemasV1.approveDeployment).toBe(ForgeCiActionInputSchemasV1.rejectDeployment);
        const repository = createForgeCiConformanceVectorsV1().github.repository;
        expect(ForgeCiActionInputSchemasV1.downloadArtifact.safeParse({ repository, runId: 'run', artifactId: 'artifact', destination: { path: '/tmp/asset' } }).success).toBe(false);
        expect(ForgeCiActionInputSchemasV1.approveDeployment.safeParse({ repository, runId: 'run', environmentIds: ['one', 'one'], comment: '' }).success).toBe(false);
        expect(ForgeCiActionInputSchemasV1.approveDeployment.parse({ repository, runId: 'run', environmentIds: ['one'], comment: '' }).comment).toBe('');
        expect(ForgeCiActionResultSchemasV1.dispatchWorkflow.safeParse({ kind: 'confirmed', affected: { repository }, receipt: {} }).success).toBe(false);
        expect(ForgeCiActionResultSchemasV1.dispatchWorkflow.parse({ kind: 'accepted', affected: { repository } }).kind).toBe('accepted');
        expect(ForgeCiActionResultSchemasV1.dispatchWorkflow.parse({ kind: 'outcome_unknown', affected: { repository, workflowId: 'workflow', ref: 'topic' } })).toMatchObject({ affected: { workflowId: 'workflow', ref: 'topic' } });
    });
});
