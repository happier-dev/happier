import { describe, expect, it } from 'vitest';
import { readHappierActionToolResultCandidates } from '@happier-dev/protocol/actions/happierActionToolResult';
import { normalizeToolResultV2 } from './index';
import { toolNormalizationSource } from './fixtures.v1.testkit';

const normalize = (rawOutput: unknown) => normalizeToolResultV2({
    source: toolNormalizationSource('acp', 'codex'),
    rawToolName: 'mcp__happier__action_spec_get',
    canonicalToolName: 'mcp__happier__action_spec_get', rawOutput,
});

describe('MCP transcript storage', () => {
    it('stores the full schema once and keeps it readable through the Action consumer', () => {
        const payload = { actionSpec: { id: 'session.stop', inputSchema: { description: 'unique-schema-body', type: 'object' } } };
        const content = [{ type: 'text', text: JSON.stringify(payload) }];
        const output = normalize({ content, text: content[0].text, structuredContent: payload,
            tool_use_result: { content, structuredContent: payload, duration: 12 } });
        expect(JSON.stringify(output).split('unique-schema-body')).toHaveLength(2);
        expect(output).toMatchObject({ content, tool_use_result: { duration: 12 } });
        expect(readHappierActionToolResultCandidates(output)).toContainEqual(payload);
        expect(normalize(output)).toEqual(output);
    });

    it('retains distinct structured facts, annotated blocks, and non-equivalent text', () => {
        const content = [{ type: 'text', text: '{"ok":true}', annotations: { audience: ['user'] } },
            { type: 'image', data: 'image-data', mimeType: 'image/png' }];
        const raw = { content, text: 'different preview', structuredContent: { ok: false },
            tool_use_result: { content: 'different native content', status: 'complete' } };
        expect(normalize(raw)).toMatchObject(raw);
    });

    it('stores flattened Claude MCP output once when only the native wrapper has structured content', () => {
        const payload = { actionSpecs: [{ description: 'claude-schema-body' }] };
        const text = JSON.stringify(payload);
        const content = [{ type: 'text', text, annotations: { audience: ['user'] } }];
        const output = normalize({ content: text, tool_use_result: {
            content, structuredContent: payload, duration: 12,
        } });
        expect(JSON.stringify(output).split('claude-schema-body')).toHaveLength(2);
        expect(output).toMatchObject({ content, tool_use_result: { duration: 12 } });
        expect(readHappierActionToolResultCandidates(output)).toContainEqual(payload);
    });

    it('does not create a text mirror for content or stdout', () => {
        for (const raw of [{ content: [{ type: 'text', text: 'body' }] }, { stdout: 'body' }]) {
            const output = normalize(raw);
            expect(output).toMatchObject(raw);
            expect(output).not.toHaveProperty('text');
        }
    });
});
