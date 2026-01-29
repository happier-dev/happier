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
            'acp/auggie/tool-call/Bash',
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

        const codexMultiPatch = fixtures.examples['codex/codex/tool-call/CodexPatch']?.find(
            (ev) => ev.payload?.callId === 'call_PATCH_MULTI_FILE',
        );
        expect(codexMultiPatch).toBeTruthy();
        const codexMultiPatchNorm = normalizeToolCallV2({
            protocol: 'codex',
            provider: 'codex',
            toolName: codexMultiPatch!.payload.name,
            rawInput: codexMultiPatch!.payload.input,
            callId: codexMultiPatch!.payload.callId,
        });
        expect(codexMultiPatchNorm.canonicalToolName).toBe('Patch');
        const multiPatchInput = asRecord(codexMultiPatchNorm.input);
        const multiChanges = asRecord(multiPatchInput?.changes);
        expect(multiChanges).toBeTruthy();
        expect(Object.keys(multiChanges!)).toHaveLength(2);
        const deleted = asRecord(multiChanges?.['/Users/leeroy/Development/happy-local/.tmp/tooltrace-codex-multi-delete.txt']);
        expect(asRecord(deleted?.delete)).toBeTruthy();

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

        const codexChangeTitle = fixtures.examples['codex/codex/tool-call/mcp__happy__change_title']?.[0];
        expect(codexChangeTitle).toBeTruthy();
        const codexChangeTitleNorm = normalizeToolCallV2({
            protocol: 'codex',
            provider: 'codex',
            toolName: codexChangeTitle!.payload.name,
            rawInput: codexChangeTitle!.payload.input,
            callId: codexChangeTitle!.payload.callId,
        });
        expect(codexChangeTitleNorm.canonicalToolName).toBe('change_title');
    });

    it('canonicalizes ACP lowercase tool names into canonical families (including heuristics for edit/write/fetch)', () => {
        const fixtures = loadFixtureV1();

        const normalizeFirst = (key: string, index = 0) => {
            const ev = fixtures.examples[key]?.[index];
            expect(ev).toBeTruthy();
            const payload = ev!.payload ?? {};
            return normalizeToolCallV2({
                protocol: ev!.protocol as any,
                provider: String(ev!.provider ?? 'unknown'),
                toolName: String(payload.name ?? ''),
                rawInput: payload.input,
                callId: typeof payload.callId === 'string' ? payload.callId : undefined,
            });
        };

        // execute → Bash (multiple ACP providers)
        expect(normalizeFirst('acp/opencode/tool-call/execute').canonicalToolName).toBe('Bash');
        expect(normalizeFirst('acp/codex/tool-call/execute').canonicalToolName).toBe('Bash');
        expect(normalizeFirst('acp/gemini/tool-call/execute').canonicalToolName).toBe('Bash');

        // read → Read
        expect(normalizeFirst('acp/opencode/tool-call/read').canonicalToolName).toBe('Read');
        expect(normalizeFirst('acp/codex/tool-call/read').canonicalToolName).toBe('Read');
        expect(normalizeFirst('acp/gemini/tool-call/read').canonicalToolName).toBe('Read');

        // glob → Glob
        expect(normalizeFirst('acp/opencode/tool-call/glob').canonicalToolName).toBe('Glob');
        expect(normalizeFirst('acp/gemini/tool-call/glob').canonicalToolName).toBe('Glob');

        // search → CodeSearch
        expect(normalizeFirst('acp/opencode/tool-call/search').canonicalToolName).toBe('CodeSearch');
        expect(normalizeFirst('acp/codex/tool-call/search').canonicalToolName).toBe('CodeSearch');
        expect(normalizeFirst('acp/gemini/tool-call/search').canonicalToolName).toBe('CodeSearch');
        expect(normalizeFirst('acp/auggie/tool-call/search').canonicalToolName).toBe('CodeSearch');

        // edit → Edit | Patch | Write (provider-dependent)
        expect(normalizeFirst('acp/opencode/tool-call/edit', 0).canonicalToolName).toBe('Write');
        expect(normalizeFirst('acp/opencode/tool-call/edit', 1).canonicalToolName).toBe('Edit');
        expect(normalizeFirst('acp/codex/tool-call/edit', 0).canonicalToolName).toBe('Patch');

        // write → Write | TodoWrite (callId-dependent)
        expect(normalizeFirst('acp/gemini/tool-call/write', 0).canonicalToolName).toBe('Write');
        expect(normalizeFirst('acp/gemini/tool-call/write', 1).canonicalToolName).toBe('TodoWrite');

        // fetch → WebSearch (query) | WebFetch (url)
        expect(normalizeFirst('acp/auggie/tool-call/fetch', 0).canonicalToolName).toBe('WebSearch');
        expect(normalizeFirst('acp/auggie/tool-call/fetch', 1).canonicalToolName).toBe('WebFetch');
    });

    it('normalizes MCP generic tools into a stable safe-display shape (title/subtitle + raw preserved)', () => {
        const fixtures = loadFixtureV1();

        const call = fixtures.examples['codex/codex/tool-call/mcp__linear__create_issue']?.[0];
        expect(call).toBeTruthy();
        const callNorm = normalizeToolCallV2({
            protocol: 'codex',
            provider: 'codex',
            toolName: call!.payload.name,
            rawInput: call!.payload.input,
            callId: call!.payload.callId,
        });
        expect(callNorm.canonicalToolName).toBe('mcp__linear__create_issue');
        const input = asRecord(callNorm.input);
        expect(input).toBeTruthy();
        expect(asRecord(input?._mcp)).toMatchObject({
            serverId: 'linear',
            toolId: 'create_issue',
        });
        expect(asRecord(input?._mcp)?.display).toBeTruthy();
        expect(typeof asRecord(asRecord(input?._mcp)?.display)?.title).toBe('string');
        expect(typeof asRecord(asRecord(input?._mcp)?.display)?.subtitle).toBe('string');

        const result = fixtures.examples['codex/codex/tool-call-result/mcp__linear__create_issue']?.[0];
        expect(result).toBeTruthy();
        const resultNorm = normalizeToolResultV2({
            protocol: 'codex',
            provider: 'codex',
            rawToolName: call!.payload.name,
            canonicalToolName: callNorm.canonicalToolName,
            rawOutput: result!.payload.output,
        });
        const out = asRecord(resultNorm);
        expect(out).toBeTruthy();
        expect(asRecord(out?._mcp)).toMatchObject({
            serverId: 'linear',
            toolId: 'create_issue',
        });
        // Coerced text is optional, but raw must always be present.
        expect(out?._raw).toBeDefined();
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

        // TodoWrite (Gemini ACP can omit actual todo content; normalization must still provide a stable `todos: []` schema)
        {
            const ev = sample('acp/gemini/tool-call/TodoWrite');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('TodoWrite');
            const input = asRecord(norm.input);
            expect(Array.isArray(input?.todos)).toBe(true);
        }

        // TodoRead
        {
            const ev = sample('acp/gemini/tool-call/TodoRead');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('TodoRead');
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

        // Glob (ACP lowercase variant)
        {
            const ev = sample('acp/opencode/tool-call/glob');
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

        // Grep (ACP lowercase variant)
        {
            const ev = sample('acp/opencode/tool-call/grep');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('Grep');
            const input = asRecord(norm.input);
            expect(typeof input?.pattern).toBe('string');
        }

        // LS
        {
            const ev = sample('acp/opencode/tool-call/ls');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('LS');
            const input = asRecord(norm.input);
            expect(typeof input?.path).toBe('string');
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
            expect(input?.operation).toBe('create');
            expect(typeof input?.subject).toBe('string');
        }

        // Auggie search (raw tool name 'search' should map to CodeSearch)
        {
            const ev = sample('acp/auggie/tool-call/search');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('CodeSearch');
            const input = asRecord(norm.input);
            expect(typeof input?.query).toBe('string');
        }

        // Auggie fetch (web query should map to WebSearch)
        {
            const ev = sample('acp/auggie/tool-call/fetch');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('WebSearch');
            const input = asRecord(norm.input);
            expect(typeof input?.query).toBe('string');
        }

        // Auggie Edit actually writes full file content (normalize to Write)
        {
            const ev = sample('acp/auggie/tool-call/Edit');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('Write');
            const input = asRecord(norm.input);
            expect(typeof input?.file_path).toBe('string');
            expect(typeof input?.content).toBe('string');
        }

        // Auggie delete is a file deletion (normalize to Delete)
        {
            const ev = sample('acp/auggie/tool-call/delete');
            const norm = normalizeFirstCall(ev);
            expect(norm.canonicalToolName).toBe('Delete');
            const input = asRecord(norm.input);
            expect(input).toMatchObject({ file_paths: ['tool_validation_results.md'] });
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

    it('canonicalizes Auggie workspace indexing permission prompts for consistent rendering', () => {
        const fixtures = loadFixtureV1();
        const ev = fixtures.examples['acp/auggie/permission-request/Unknown tool']?.[0];
        expect(ev).toBeTruthy();

        const payload = ev!.payload ?? {};
        const toolName = String(payload.toolName ?? '');
        const rawInput =
            payload?.options?.toolCall
            ?? payload?.options?.input
            ?? payload?.options
            ?? {};
        const callId = typeof payload.permissionId === 'string' ? payload.permissionId : undefined;

        const normalized = normalizeToolCallV2({
            protocol: ev!.protocol as any,
            provider: String(ev!.provider ?? 'unknown'),
            toolName,
            rawInput,
            callId,
        });

        expect(normalized.canonicalToolName).toBe('WorkspaceIndexingPermission');
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
                if (canonicalToolName === 'TodoWrite' || canonicalToolName === 'TodoRead') {
                    const todos = outRecord?.todos;
                    expect(Array.isArray(todos)).toBe(true);
                    if (Array.isArray(todos) && todos.length > 0) {
                        const first = asRecord(todos[0]);
                        expect(typeof first?.content).toBe('string');
                        expect(typeof first?.status).toBe('string');
                    }
                }
                if (canonicalToolName === 'Patch') {
                    const raw = asRecord(rawOutput);
                    const rawApplied =
                        typeof raw?.success === 'boolean'
                            ? raw.success
                            : typeof raw?.ok === 'boolean'
                                ? raw.ok
                                : typeof raw?.applied === 'boolean'
                                    ? raw.applied
                                    : null;
                    if (typeof rawApplied === 'boolean') {
                        expect(outRecord?.applied).toBe(rawApplied);
                    }
                    const stdout = outRecord?.stdout;
                    const stderr = outRecord?.stderr;
                    expect(stdout == null || typeof stdout === 'string').toBe(true);
                    expect(stderr == null || typeof stderr === 'string').toBe(true);
                }
                if (canonicalToolName === 'Glob') {
                    const matches = outRecord?.matches;
                    expect(Array.isArray(matches)).toBe(true);
                    if (Array.isArray(matches) && matches.length > 0) {
                        expect(matches.every((m: any) => typeof m === 'string')).toBe(true);
                    }
                }
                if (canonicalToolName === 'Grep') {
                    const matches = outRecord?.matches;
                    expect(Array.isArray(matches)).toBe(true);
                    if (Array.isArray(matches) && matches.length > 0) {
                        const first = asRecord(matches[0]);
                        // Prefer the canonical `filePath` field, but allow excerpt-only matches when providers redact or summarize.
                        const hasFilePath = typeof first?.filePath === 'string';
                        const hasExcerpt = typeof first?.excerpt === 'string';
                        expect(hasFilePath || hasExcerpt).toBe(true);
                    }
                }
                if (canonicalToolName === 'CodeSearch') {
                    const matches = outRecord?.matches;
                    expect(Array.isArray(matches)).toBe(true);
                    if (Array.isArray(matches) && matches.length > 0) {
                        const first = asRecord(matches[0]);
                        // Either we parsed structured output (filePath/line/excerpt) or we fell back to an excerpt-only match.
                        const hasFilePath = typeof first?.filePath === 'string';
                        const hasExcerpt = typeof first?.excerpt === 'string';
                        expect(hasFilePath || hasExcerpt).toBe(true);
                    }
                }
                if (canonicalToolName === 'LS') {
                    const entries = outRecord?.entries;
                    expect(Array.isArray(entries)).toBe(true);
                    if (Array.isArray(entries) && entries.length > 0) {
                        expect(entries.every((m: any) => typeof m === 'string')).toBe(true);
                    }
                }
            }
        }
    });

    it('normalizes web tool results into stable schemas (WebSearch.results[], WebFetch.status/text/errorMessage)', () => {
        const fixtures = loadFixtureV1();

        const fetchCalls = fixtures.examples['acp/auggie/tool-call/fetch'];
        expect(fetchCalls).toBeTruthy();
        const fetchResults = fixtures.examples['acp/auggie/tool-result/fetch'];
        expect(fetchResults).toBeTruthy();

        const pickCall = (predicate: (input: any) => boolean) => {
            const ev = fetchCalls!.find((e) => predicate(e.payload?.input));
            expect(ev).toBeTruthy();
            return ev!;
        };

        const pickResultByCallId = (callId: string) => {
            const ev = fetchResults!.find((e) => e.payload?.callId === callId);
            expect(ev).toBeTruthy();
            return ev!;
        };

        // WebSearch (query → results list)
        {
            const call = pickCall((input) => typeof input?.query === 'string' && String(input.query).includes('TypeScript'));
            const callId = call.payload.callId as string;
            const { canonicalToolName } = normalizeToolCallV2({
                protocol: 'acp',
                provider: 'auggie',
                toolName: call.payload.name,
                rawInput: call.payload.input,
                callId,
            });
            expect(canonicalToolName).toBe('WebSearch');

            const resultEv = pickResultByCallId(callId);
            const normalized = normalizeToolResultV2({
                protocol: 'acp',
                provider: 'auggie',
                rawToolName: 'fetch',
                canonicalToolName,
                rawOutput: resultEv.payload.output,
            });

            const outRecord = asRecord(normalized);
            expect(Array.isArray(outRecord?.results)).toBe(true);
        }

        // WebSearch empty response (results should still exist and be a list)
        {
            const call = pickCall((input) => typeof input?.query === 'string' && String(input.query).includes('no results'));
            const callId = call.payload.callId as string;
            const { canonicalToolName } = normalizeToolCallV2({
                protocol: 'acp',
                provider: 'auggie',
                toolName: call.payload.name,
                rawInput: call.payload.input,
                callId,
            });
            expect(canonicalToolName).toBe('WebSearch');

            const resultEv = pickResultByCallId(callId);
            const normalized = normalizeToolResultV2({
                protocol: 'acp',
                provider: 'auggie',
                rawToolName: 'fetch',
                canonicalToolName,
                rawOutput: resultEv.payload.output,
            });

            const outRecord = asRecord(normalized);
            expect(outRecord).toMatchObject({ results: [] });
        }

        // WebSearch string-only response (should normalize into results[])
        {
            const call = pickCall((input) => typeof input?.query === 'string' && String(input.query).includes('string-only'));
            const callId = call.payload.callId as string;
            const { canonicalToolName } = normalizeToolCallV2({
                protocol: 'acp',
                provider: 'auggie',
                toolName: call.payload.name,
                rawInput: call.payload.input,
                callId,
            });
            expect(canonicalToolName).toBe('WebSearch');

            const resultEv = pickResultByCallId(callId);
            const normalized = normalizeToolResultV2({
                protocol: 'acp',
                provider: 'auggie',
                rawToolName: 'fetch',
                canonicalToolName,
                rawOutput: resultEv.payload.output,
            });

            const outRecord = asRecord(normalized);
            expect(Array.isArray(outRecord?.results)).toBe(true);
            const first = Array.isArray(outRecord?.results) ? asRecord(outRecord?.results[0]) : null;
            expect(typeof first?.snippet).toBe('string');
        }

        // WebFetch (url → status + text)
        {
            const call = pickCall((input) => typeof input?.url === 'string' && String(input.url).includes('example.com'));
            const callId = call.payload.callId as string;
            const { canonicalToolName } = normalizeToolCallV2({
                protocol: 'acp',
                provider: 'auggie',
                toolName: call.payload.name,
                rawInput: call.payload.input,
                callId,
            });
            expect(canonicalToolName).toBe('WebFetch');

            const resultEv = pickResultByCallId(callId);
            const normalized = normalizeToolResultV2({
                protocol: 'acp',
                provider: 'auggie',
                rawToolName: 'fetch',
                canonicalToolName,
                rawOutput: resultEv.payload.output,
            });

            const outRecord = asRecord(normalized);
            expect(typeof outRecord?.status).toBe('number');
            expect(typeof outRecord?.text).toBe('string');
        }

        // WebFetch error (status ≥ 400 should surface a stable errorMessage when provided)
        {
            const call = pickCall((input) => typeof input?.url === 'string' && String(input.url).includes('blocked.example.com'));
            const callId = call.payload.callId as string;
            const { canonicalToolName } = normalizeToolCallV2({
                protocol: 'acp',
                provider: 'auggie',
                toolName: call.payload.name,
                rawInput: call.payload.input,
                callId,
            });
            expect(canonicalToolName).toBe('WebFetch');

            const resultEv = pickResultByCallId(callId);
            const normalized = normalizeToolResultV2({
                protocol: 'acp',
                provider: 'auggie',
                rawToolName: 'fetch',
                canonicalToolName,
                rawOutput: resultEv.payload.output,
            });

            const outRecord = asRecord(normalized);
            expect(typeof outRecord?.status).toBe('number');
            expect(typeof outRecord?.errorMessage).toBe('string');
        }
    });
});
