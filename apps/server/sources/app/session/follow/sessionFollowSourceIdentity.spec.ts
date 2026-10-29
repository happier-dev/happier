import { describe, expect, it } from 'vitest';
import { sourceForSessionFollowEdgeV1, sourceKeyForSessionFollowSourceV1 } from './sessionFollowSourceIdentity';

describe('exact retained Run Follow identity', () => {
    it('keeps detached Machine Runs distinct from Session Runs and rejects ambiguous persisted anchors', () => {
        const source = { kind: 'execution_run' as const, machineId: 'same-id', runId: 'run' };
        const sourceKey = sourceKeyForSessionFollowSourceV1(source);
        expect(sourceKey).not.toBe(sourceKeyForSessionFollowSourceV1({ ...source, machineId: 'other-machine' }));
        expect(sourceKey).not.toBe(sourceKeyForSessionFollowSourceV1({ kind: 'execution_run', sessionId: 'same-id', runId: 'run' }));
        // Retained Session Run keys predate the Machine arm and must not be re-keyed.
        const sessionSource = { kind: 'execution_run' as const, sessionId: 'same-id', runId: 'run' };
        const sessionKey = 'execution_run:23a8f6b3b2c8070807fc178eca4a2ac340015ec50fef919dafac6a452ee27115';
        expect(sourceKeyForSessionFollowSourceV1(sessionSource)).toBe(sessionKey);
        const row = { sourceKey, sourceSessionId: null, sourceDiscussionId: null,
            sourceExecutionRunSessionId: null, sourceExecutionRunMachineId: source.machineId,
            sourceExecutionRunId: source.runId, sourceWorkflowRunId: null };
        expect(sourceForSessionFollowEdgeV1(row)).toEqual(source);
        expect(sourceForSessionFollowEdgeV1({ ...row, sourceExecutionRunSessionId: 'same-id' })).toBeNull();
        expect(sourceForSessionFollowEdgeV1({ ...row, sourceExecutionRunMachineId: null })).toBeNull();
        expect(sourceForSessionFollowEdgeV1({ ...row, sourceExecutionRunMachineId: 'other-machine' })).toBeNull();
        expect(sourceForSessionFollowEdgeV1({ ...row, sourceWorkflowRunId: 'workflow' })).toBeNull();
        expect(sourceForSessionFollowEdgeV1({ ...row, sourceKey: sessionKey,
            sourceExecutionRunSessionId: 'same-id', sourceExecutionRunMachineId: null })).toEqual(sessionSource);
    });
});
