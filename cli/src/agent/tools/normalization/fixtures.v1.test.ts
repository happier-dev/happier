import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalizeToolNameV2, normalizeToolCallV2, normalizeToolResultV2 } from './index';

type ToolTraceEventV1 = {
    v: 1;
    protocol: 'acp' | 'codex' | 'claude' | string;
    provider: string;
    kind: string;
    payload: any;
};

type ToolTraceFixturesV1 = {
    v: 1;
    generatedAt: number;
    examples: Record<string, ToolTraceEventV1[]>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function loadFixtureV1(): ToolTraceFixturesV1 {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fixturePath = path.join(here, '__fixtures__', 'tool-trace-fixtures.v1.json');
    const raw = readFileSync(fixturePath, 'utf8');
    return JSON.parse(raw) as ToolTraceFixturesV1;
}

function getCallIdFromEvent(event: ToolTraceEventV1): string | null {
    const payload = event.payload ?? {};
    const callId =
        typeof payload.callId === 'string'
            ? payload.callId
            : typeof payload.permissionId === 'string'
                ? payload.permissionId
                : null;
    return callId;
}

describe('tool normalization fixtures (v1)', () => {
    it('includes baseline coverage across protocols/providers', () => {
        const fixtures = loadFixtureV1();
        const keys = Object.keys(fixtures.examples);

        expect(keys).toEqual(expect.arrayContaining([
            'acp/opencode/tool-call/execute',
            'acp/gemini/permission-request/edit',
            'acp/codex/tool-call/execute',
            'codex/codex/tool-call/CodexBash',
            'claude/claude/tool-call/Bash',
        ]));
    });

    it('normalizes tool-call events into canonical tool names + V2 metadata', () => {
        const fixtures = loadFixtureV1();
        expect(fixtures.v).toBe(1);

        for (const events of Object.values(fixtures.examples)) {
            for (const event of events) {
                if (event.kind !== 'tool-call') continue;

                const payload = event.payload ?? {};
                const toolName = String(payload.name ?? '');
                const callId = typeof payload.callId === 'string' ? payload.callId : undefined;
                expect(toolName.length).toBeGreaterThan(0);

                const normalized = normalizeToolCallV2({
                    protocol: event.protocol as any,
                    provider: String(event.provider ?? 'unknown'),
                    toolName,
                    rawInput: payload.input,
                    callId,
                });

                expect(typeof normalized.canonicalToolName).toBe('string');
                expect(normalized.canonicalToolName.length).toBeGreaterThan(0);

                const inputRecord = asRecord(normalized.input);
                expect(inputRecord).toBeTruthy();
                expect(asRecord(inputRecord?._happy)).toMatchObject({
                    v: 2,
                    protocol: event.protocol,
                    provider: event.provider,
                    rawToolName: toolName,
                    canonicalToolName: normalized.canonicalToolName,
                });
                expect(inputRecord?._raw).toBeDefined();
            }
        }
    });

    it('applies key canonical tool-call transformations (execute→Bash, CodexDiff→Diff, CodexPatch→Patch, GeminiReasoning→Reasoning)', () => {
        const fixtures = loadFixtureV1();

        const exec = fixtures.examples['acp/opencode/tool-call/execute']?.[0];
        expect(exec).toBeTruthy();
        const execNorm = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'opencode',
            toolName: exec!.payload.name,
            rawInput: exec!.payload.input,
            callId: exec!.payload.callId,
        });
        expect(execNorm.canonicalToolName).toBe('Bash');
        // Some providers omit command details entirely in tool-call input (e.g. OpenCode ACP can emit execute calls with empty rawInput).
        // The canonicalization must still succeed, but we only assert command existence when providers supply it.

        const codexBash = fixtures.examples['codex/codex/tool-call/CodexBash']?.[0];
        expect(codexBash).toBeTruthy();
        const codexBashNorm = normalizeToolCallV2({
            protocol: 'codex',
            provider: 'codex',
            toolName: codexBash!.payload.name,
            rawInput: codexBash!.payload.input,
            callId: codexBash!.payload.callId,
        });
        expect(codexBashNorm.canonicalToolName).toBe('Bash');
        expect(typeof asRecord(codexBashNorm.input)?.command).toBe('string');

        const codexDiff = fixtures.examples['codex/codex/tool-call/CodexDiff']?.[0];
        expect(codexDiff).toBeTruthy();
        const codexDiffNorm = normalizeToolCallV2({
            protocol: 'codex',
            provider: 'codex',
            toolName: codexDiff!.payload.name,
            rawInput: codexDiff!.payload.input,
            callId: codexDiff!.payload.callId,
        });
        expect(codexDiffNorm.canonicalToolName).toBe('Diff');
        expect(typeof asRecord(codexDiffNorm.input)?.unified_diff).toBe('string');

        const codexPatch = fixtures.examples['codex/codex/tool-call/CodexPatch']?.[0];
        expect(codexPatch).toBeTruthy();
        const codexPatchNorm = normalizeToolCallV2({
            protocol: 'codex',
            provider: 'codex',
            toolName: codexPatch!.payload.name,
            rawInput: codexPatch!.payload.input,
            callId: codexPatch!.payload.callId,
        });
        expect(codexPatchNorm.canonicalToolName).toBe('Patch');
        const patchInput = asRecord(codexPatchNorm.input);
        expect(asRecord(patchInput?.changes)).toBeTruthy();

        const reasoning = fixtures.examples['acp/gemini/tool-call/GeminiReasoning']?.[0];
        expect(reasoning).toBeTruthy();
        const reasoningNorm = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'gemini',
            toolName: reasoning!.payload.name,
            rawInput: reasoning!.payload.input,
            callId: reasoning!.payload.callId,
        });
        expect(reasoningNorm.canonicalToolName).toBe('Reasoning');
    });

    it('normalizes tool-call inputs for file/search/web tools (surfaces key fields when provided)', () => {
        const fixtures = loadFixtureV1();

        const sample = (key: string): ToolTraceEventV1 => {
            const ev = fixtures.examples[key]?.[0];
            expect(ev).toBeTruthy();
            return ev!;
        };

        const normalizeFirstCall = (ev: ToolTraceEventV1) => {
            const payload = ev.payload ?? {};
            return normalizeToolCallV2({
                protocol: ev.protocol as any,
                provider: String(ev.provider ?? 'unknown'),
                toolName: String(payload.name ?? ''),
                rawInput: payload.input,
                callId:
                    typeof payload.callId === 'string'
                        ? payload.callId
                        : typeof payload.id === 'string'
                            ? payload.id
                            : undefined,
            });
        };

        // Write
        {
            const ev = sample('claude/claude/tool-call/Write');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('Write');
            const input = asRecord(norm.input);
            expect(typeof input?.file_path).toBe('string');
            expect(typeof input?.content).toBe('string');
        }

        // TodoWrite
        {
            const ev = sample('claude/claude/tool-call/TodoWrite');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('TodoWrite');
            const input = asRecord(norm.input);
            expect(Array.isArray(input?.todos)).toBe(true);
        }

        // Edit
        {
            const ev = sample('claude/claude/tool-call/Edit');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('Edit');
            const input = asRecord(norm.input);
            expect(typeof input?.file_path).toBe('string');
            expect(typeof input?.old_string).toBe('string');
            expect(typeof input?.new_string).toBe('string');
        }

        // CodeSearch (provider raw tool name 'search')
        {
            const ev = sample('acp/opencode/tool-call/search');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('CodeSearch');
            const input = asRecord(norm.input);
            expect(typeof input?.query).toBe('string');
        }

        // Glob
        {
            const ev = sample('claude/claude/tool-call/Glob');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('Glob');
            const input = asRecord(norm.input);
            expect(typeof input?.pattern).toBe('string');
        }

        // Grep
        {
            const ev = sample('claude/claude/tool-call/Grep');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('Grep');
            const input = asRecord(norm.input);
            expect(typeof input?.pattern).toBe('string');
        }

        // WebSearch
        {
            const ev = sample('claude/claude/tool-call/WebSearch');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('WebSearch');
            const input = asRecord(norm.input);
            expect(typeof input?.query).toBe('string');
        }

        // WebFetch
        {
            const ev = sample('claude/claude/tool-call/WebFetch');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('WebFetch');
            const input = asRecord(norm.input);
            expect(typeof input?.url).toBe('string');
        }

        // AskUserQuestion
        {
            const ev = sample('claude/claude/tool-call/AskUserQuestion');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('AskUserQuestion');
            const input = asRecord(norm.input);
            expect(Array.isArray(input?.questions)).toBe(true);
        }

        // Task helpers (TaskCreate/TaskList/TaskUpdate all normalize to Task)
        {
            const ev = sample('claude/claude/tool-call/TaskCreate');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('Task');
            const input = asRecord(norm.input);
            expect(typeof input?.subject).toBe('string');
        }
    });

    it('normalizes permission-request events without throwing (derives a canonical tool name)', () => {
        const fixtures = loadFixtureV1();

        for (const events of Object.values(fixtures.examples)) {
            for (const event of events) {
                if (event.kind !== 'permission-request') continue;

                const payload = event.payload ?? {};
                const toolName = String(payload.toolName ?? '');
                expect(toolName.length).toBeGreaterThan(0);

                const rawInput =
                    payload?.options?.toolCall
                    ?? payload?.options?.input
                    ?? payload?.options
                    ?? {};
                const callId = typeof payload.permissionId === 'string' ? payload.permissionId : undefined;

                const normalized = normalizeToolCallV2({
                    protocol: event.protocol as any,
                    provider: String(event.provider ?? 'unknown'),
                    toolName,
                    rawInput,
                    callId,
                });

                expect(typeof normalized.canonicalToolName).toBe('string');
                expect(normalized.canonicalToolName.length).toBeGreaterThan(0);
                expect(asRecord(normalized.input)?._raw).toBeDefined();
            }
        }
    });

    it('normalizes tool-result events into objects with V2 metadata (using tool-call mappings when available)', () => {
        const fixtures = loadFixtureV1();

        const callIdToTool: Map<string, { canonicalToolName: string; rawToolName: string }> = new Map();

        for (const events of Object.values(fixtures.examples)) {
            for (const event of events) {
                if (event.kind !== 'tool-call') continue;
                const payload = event.payload ?? {};
                const callId = typeof payload.callId === 'string' ? payload.callId : null;
                if (!callId) continue;
                const toolName = String(payload.name ?? '');
                const normalized = normalizeToolCallV2({
                    protocol: event.protocol as any,
                    provider: String(event.provider ?? 'unknown'),
                    toolName,
                    rawInput: payload.input,
                    callId,
                });
                callIdToTool.set(`${event.protocol}/${event.provider}/${callId}`, {
                    canonicalToolName: normalized.canonicalToolName,
                    rawToolName: toolName,
                });
            }
        }

        for (const events of Object.values(fixtures.examples)) {
            for (const event of events) {
                if (event.kind !== 'tool-result' && event.kind !== 'tool-call-result') continue;

                const callId = getCallIdFromEvent(event);
                if (!callId) continue;

                const key = `${event.protocol}/${event.provider}/${callId}`;
                const mapping = callIdToTool.get(key);

                const canonicalToolName =
                    mapping?.canonicalToolName
                    ?? canonicalizeToolNameV2({ protocol: event.protocol as any, toolName: 'Unknown' });
                const rawToolName = mapping?.rawToolName ?? 'unknown';

                const payload = event.payload ?? {};
                const rawOutput = payload.output;

                const normalized = normalizeToolResultV2({
                    protocol: event.protocol as any,
                    provider: String(event.provider ?? 'unknown'),
                    rawToolName,
                    canonicalToolName,
                    rawOutput,
                });

                const outRecord = asRecord(normalized);
                expect(outRecord).toBeTruthy();
                expect(asRecord(outRecord?._happy)).toMatchObject({
                    v: 2,
                    protocol: event.protocol,
                    provider: event.provider,
                });
                expect(outRecord?._raw).toBeDefined();

                if (canonicalToolName === 'Bash') {
                    // For Bash, the V2 result normalizer should surface stdout/stderr/exit_code consistently.
                    const stdout = outRecord?.stdout;
                    expect(stdout == null || typeof stdout === 'string').toBe(true);
                }
                if (canonicalToolName === 'Read') {
                    // For Read, prefer the wrapper object when output is a string or object with content.
                    const file = asRecord(outRecord?.file);
                    if (typeof rawOutput === 'string') {
                        expect(file).toBeTruthy();
                        expect(typeof file?.content).toBe('string');
                        // Opencode-style wrappers should include line metadata when present.
                        if (rawOutput.includes('<file>')) {
                            expect(typeof file?.startLine).toBe('number');
                        }
                    }
                }
                if (canonicalToolName === 'Reasoning') {
                    const content = outRecord?.content;
                    expect(content == null || typeof content === 'string').toBe(true);
                }
            }
        }
    });
});
