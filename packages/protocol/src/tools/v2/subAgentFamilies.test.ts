import { describe, expect, it } from 'vitest';

import {
    isAsyncSubAgentLaunchToolResult,
    isGenericSubAgentToolName,
} from './subAgentFamilies.js';

describe('generic sub-agent tool family', () => {
    it('recognises every alias the generic sub-agent tool has carried', () => {
        expect(isGenericSubAgentToolName('Task')).toBe(true);
        expect(isGenericSubAgentToolName('Agent')).toBe(true);
        expect(isGenericSubAgentToolName('SubAgent')).toBe(true);
        expect(isGenericSubAgentToolName('Bash')).toBe(false);
    });
});

describe('isAsyncSubAgentLaunchToolResult', () => {
    // OBSERVED shape (live Claude Code session, 2026-08-17): the generic sub-agent tool returns
    // within milliseconds carrying only an acknowledgement, and the agent's real answer arrives
    // later against the same tool-use id.
    const ACKNOWLEDGEMENT = {
        isAsync: true,
        status: 'async_launched',
        agentId: 'aec7336148831a599',
        description: 'Fix fork identity and UI gaps',
        outputFile: '/tmp/tasks/aec7336148831a599.output',
    };

    it('reads a launch acknowledgement as a launch, not an answer', () => {
        expect(isAsyncSubAgentLaunchToolResult(ACKNOWLEDGEMENT)).toBe(true);
        expect(isAsyncSubAgentLaunchToolResult({ status: 'remote_launched' })).toBe(true);
        expect(isAsyncSubAgentLaunchToolResult({ status: '  Async_Launched  ' })).toBe(true);
    });

    it('reads it through both envelopes the two channels wrap it in', () => {
        // The transcript normalizer JSON-encodes the raw `toolUseResult`; the live log converter
        // nests the same object one level down under a snake_cased key.
        expect(isAsyncSubAgentLaunchToolResult(JSON.stringify(ACKNOWLEDGEMENT))).toBe(true);
        expect(isAsyncSubAgentLaunchToolResult({ tool_use_result: ACKNOWLEDGEMENT })).toBe(true);
        expect(isAsyncSubAgentLaunchToolResult({ toolUseResult: ACKNOWLEDGEMENT })).toBe(true);
    });

    it('answers false for a genuine result rather than reclassifying it', () => {
        expect(isAsyncSubAgentLaunchToolResult('All six findings closed at one owner each.')).toBe(false);
        expect(isAsyncSubAgentLaunchToolResult({ status: 'completed' })).toBe(false);
        expect(isAsyncSubAgentLaunchToolResult({ status: 'failed' })).toBe(false);
        expect(isAsyncSubAgentLaunchToolResult(undefined)).toBe(false);
        expect(isAsyncSubAgentLaunchToolResult(null)).toBe(false);
        expect(isAsyncSubAgentLaunchToolResult([{ status: 'async_launched' }])).toBe(false);
        expect(isAsyncSubAgentLaunchToolResult('{ not json')).toBe(false);
    });
});
