import { describe, expect, it } from 'vitest';

import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';

import { resolveTranscriptWorkflowRunReference } from './transcriptWorkflowRunReference';

/**
 * The discriminating step of the agent-origin managed workflow journey.
 *
 * A transcript row may only claim "this call admitted that exact Run" when the
 * recorded result is the canonical `workflow.run.start` result — parsed by the
 * Protocol owner, never by a local schema. Everything here is a way that proof
 * can be absent while the row still looks convincing: an unfinished call, a
 * failure envelope, a read Action whose result also carries a `run`, prose, a
 * lookalike tool from another MCP server.
 */

const RUN_ID = '0f2cf13d-4ad7-4f4b-b5e0-cc3b7dce7f11';
const START_TOOL = 'mcp__happier__workflow_run_start';

function startResult(overrides: Record<string, unknown> = {}) {
    return {
        run: createWorkflowRunSummaryFixture({
            id: RUN_ID,
            origin: { kind: 'direct', originSessionId: 'session-1' },
        }),
        admission: 'created',
        ...overrides,
    };
}

function resolve(overrides: Partial<Parameters<typeof resolveTranscriptWorkflowRunReference>[0]> = {}) {
    return resolveTranscriptWorkflowRunReference({
        toolName: START_TOOL,
        state: 'completed',
        result: JSON.stringify(startResult()),
        ...overrides,
    });
}

describe('resolveTranscriptWorkflowRunReference', () => {
    it('references the exact Run a completed direct start admitted', () => {
        expect(resolve()).toEqual({
            runId: RUN_ID,
            origin: { kind: 'direct', originSessionId: 'session-1' },
        });
    });

    it('accepts the executor envelope and the MCP content envelope through the one Protocol parser', () => {
        expect(resolve({ result: { ok: true, result: startResult() } })?.runId).toBe(RUN_ID);
        expect(resolve({
            result: { content: [{ type: 'text', text: JSON.stringify(startResult()) }] },
        })?.runId).toBe(RUN_ID);
        expect(resolve({
            result: { content: [{ type: 'text', text: 'ignored' }], structuredContent: startResult() },
        })?.runId).toBe(RUN_ID);
        // An `existing` admission is the same exact Run rejoined after response
        // loss; it is not a weaker acknowledgement.
        expect(resolve({ result: JSON.stringify(startResult({ admission: 'existing' })) })?.runId).toBe(RUN_ID);
    });

    it('keeps the declared origin rather than inferring one from the row', () => {
        expect(resolve({
            result: JSON.stringify(startResult({
                run: createWorkflowRunSummaryFixture({ id: RUN_ID, origin: { kind: 'automation', automationId: 'automation-1' } }),
            })),
        })?.origin).toEqual({ kind: 'automation', automationId: 'automation-1' });
    });

    it('accepts the direct Agent tool name and rejects a foreign server with the same trailing name', () => {
        expect(resolve({ toolName: 'workflow_run_start' })?.runId).toBe(RUN_ID);
        expect(resolve({ toolName: 'happier__workflow_run_start' })?.runId).toBe(RUN_ID);
        expect(resolve({ toolName: 'mcp__acme__workflow_run_start' })).toBeNull();
    });

    it('ignores a call that has not truthfully admitted a Run', () => {
        expect(resolve({ state: 'running' })).toBeNull();
        expect(resolve({ state: 'error' })).toBeNull();
        expect(resolve({ result: null })).toBeNull();
        expect(resolve({ result: 'Started the workflow for you.' })).toBeNull();
        expect(resolve({ result: '{"run":{"id":"' })).toBeNull();
    });

    it('ignores typed failures and a deferred approval continuation', () => {
        for (const errorCode of ['run_not_found', 'feature_disabled', 'workflow_wait_self_dependency']) {
            expect(resolve({
                result: { ok: false, errorCode, error: errorCode, details: { runId: RUN_ID } },
            })).toBeNull();
        }
        expect(resolve({
            result: {
                ok: true,
                result: { kind: 'approval_request_created', artifactId: 'artifact-1', actionId: 'workflow.run.start' },
            },
        })).toBeNull();
    });

    it('mounts nothing for the workflow Actions that only read or control a Run', () => {
        // A read result also carries `run`; only the start Action acknowledges
        // an admission this row can claim.
        expect(resolve({
            toolName: 'mcp__happier__workflow_run_get',
            result: JSON.stringify({ ...startResult(), admission: undefined }),
        })).toBeNull();
        expect(resolve({
            toolName: 'mcp__happier__workflow_run_cancel',
            result: JSON.stringify({ run: startResult().run, intent: 'cancel_requested' }),
        })).toBeNull();
    });

    it('mounts nothing for an unrelated tool call or a Board result', () => {
        expect(resolve({ toolName: 'Read', result: 'ok' })).toBeNull();
        expect(resolve({
            toolName: 'mcp__happier__session_board_item_upsert',
            result: JSON.stringify({ v: 1, serverId: 'home-a', sessionId: 'session-1', result: { operation: 'upsert_item' } }),
        })).toBeNull();
    });
});
