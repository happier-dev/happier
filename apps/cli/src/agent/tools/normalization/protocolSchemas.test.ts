import { describe, expect, it } from 'vitest';

import {
    KNOWN_CANONICAL_TOOL_NAMES_V2,
    ToolHappierMetaV2Schema,
    ToolHappyMetaV2Schema,
    getToolInputSchemaV2,
    getToolResultSchemaV2,
} from '@happier-dev/protocol';

describe('protocol tool v2 schemas', () => {
    it('exports known canonical tool names (includes core + structured tools)', () => {
        expect(KNOWN_CANONICAL_TOOL_NAMES_V2).toContain('Bash');
        expect(KNOWN_CANONICAL_TOOL_NAMES_V2).toContain('Read');
        expect(KNOWN_CANONICAL_TOOL_NAMES_V2).toContain('Write');
        expect(KNOWN_CANONICAL_TOOL_NAMES_V2).toContain('Patch');
        expect(KNOWN_CANONICAL_TOOL_NAMES_V2).toContain('Diff');

        expect(KNOWN_CANONICAL_TOOL_NAMES_V2).toContain('EnterPlanMode');
        expect(KNOWN_CANONICAL_TOOL_NAMES_V2).toContain('ExitPlanMode');
        expect(KNOWN_CANONICAL_TOOL_NAMES_V2).toContain('AskUserQuestion');
        expect(KNOWN_CANONICAL_TOOL_NAMES_V2).toContain('AcpHistoryImport');
        expect(KNOWN_CANONICAL_TOOL_NAMES_V2).toContain('WorkspaceIndexingPermission');
        expect(KNOWN_CANONICAL_TOOL_NAMES_V2).toContain('change_title');
    });

    it('parses v2 _happy metadata', () => {
        // Ensure the "happier" naming exists (project rename), while keeping the
        // wire-level `_happy` field stable for backward compatibility.
        expect(ToolHappierMetaV2Schema).toBeDefined();

        const parsed = ToolHappierMetaV2Schema.parse({
            v: 2,
            protocol: 'acp',
            provider: 'opencode',
            rawToolName: 'execute',
            canonicalToolName: 'Bash',
        });

        expect(parsed.v).toBe(2);
        expect(parsed.canonicalToolName).toBe('Bash');
    });

    it('allows forward-compatible canonical tool names in _happy metadata', () => {
        const parsed = ToolHappierMetaV2Schema.parse({
            v: 2,
            protocol: 'acp',
            provider: 'future',
            rawToolName: 'future_tool',
            canonicalToolName: 'FutureToolName',
        });

        expect(parsed.canonicalToolName).toBe('FutureToolName');
    });

    it('provides per-tool input/result schemas for known tools', () => {
        const bashInputSchema = getToolInputSchemaV2('Bash');
        const parsedInput = bashInputSchema.parse({ command: 'echo hello' });
        expect(parsedInput.command).toBe('echo hello');

        const bashResultSchema = getToolResultSchemaV2('Bash');
        const parsedResult = bashResultSchema.parse({ stdout: 'hello\n', exit_code: 0 });
        expect(parsedResult.exit_code).toBe(0);
    });
});
