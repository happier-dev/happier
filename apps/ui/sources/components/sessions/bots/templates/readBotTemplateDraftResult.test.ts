import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { readBotTemplateDraftResult } from './readBotTemplateDraftResult';

const result = { draftArtifactId: '1f34ad50-41b4-470c-bdb0-adbbbd6b2bcb', revision: { headerVersion: 1, bodyVersion: 1 },
    sourceSessionRef: { serverId: 'home', sessionId: 'source' }, summary: {
        identity: { name: 'Garden', description: 'Plant care' },
        includes: { memoryRules: 0, skills: 0, software: 0, connectedAccounts: 0, mcpServers: 0 },
        leftOut: { memoryRules: 1, skills: 1 },
    } };
const tool = { id: 'call', name: 'happier_action_execute', state: 'completed', input: { actionId: 'template.draft', input: {} },
    result: { ok: true, result }, createdAt: 0, startedAt: 0, completedAt: 0, description: null } satisfies ToolCall;

describe('private template draft transcript outcome', () => {
    it('reads the canonical successful draft Action result including its source address', () => {
        expect(readBotTemplateDraftResult(tool)).toEqual(result);
    });
    it('does not turn failures, partial calls, other Actions, or malformed envelopes into a template door', () => {
        expect(readBotTemplateDraftResult({ ...tool, state: 'running' })).toBeNull();
        expect(readBotTemplateDraftResult({ ...tool, input: { actionId: 'artifact.get' } })).toBeNull();
        expect(readBotTemplateDraftResult({ ...tool, result: { ok: false, result } })).toBeNull();
        expect(readBotTemplateDraftResult({ ...tool, result: { ok: true, result: { ...result, sourceSessionRef: undefined } } })).toBeNull();
    });
});
