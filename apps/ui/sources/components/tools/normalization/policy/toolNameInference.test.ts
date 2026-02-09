import { describe, expect, it } from 'vitest';
import { inferToolNameForRendering } from './toolNameInference';

describe('inferToolNameForRendering', () => {
    const known = ['read', 'write', 'edit', 'bash', 'execute', 'TodoWrite', 'TodoRead'];

    it('keeps original known names even when conflicting hints exist in input', () => {
        const result = inferToolNameForRendering({
            toolName: 'read',
            toolInput: { toolName: 'write', permission: { toolName: 'edit' } },
            toolDescription: 'bash',
            knownToolKeys: known,
        });
        expect(result).toEqual({ normalizedToolName: 'read', source: 'original' });
    });

    it('prefers toolInput.toolName when tool name is unknown', () => {
        const result = inferToolNameForRendering({
            toolName: 'unknown',
            toolInput: { toolName: 'read', filepath: '/etc/hosts' },
            toolDescription: null,
            knownToolKeys: known,
        });
        expect(result).toEqual({ normalizedToolName: 'read', source: 'toolInputToolName' });
    });

    it('falls back to toolInput.permission.toolName when present', () => {
        const result = inferToolNameForRendering({
            toolName: 'unknown',
            toolInput: { permission: { toolName: 'write' } },
            toolDescription: null,
            knownToolKeys: known,
        });
        expect(result).toEqual({ normalizedToolName: 'write', source: 'toolInputPermissionToolName' });
    });

    it('ignores _acp.kind=unknown and falls back to other hints', () => {
        const result = inferToolNameForRendering({
            toolName: 'Run echo hello',
            toolInput: { _acp: { kind: 'unknown' }, toolName: 'write' },
            toolDescription: null,
            knownToolKeys: known,
        });
        expect(result).toEqual({ normalizedToolName: 'write', source: 'toolInputToolName' });
    });

    it('uses _acp.kind when present and non-unknown', () => {
        const result = inferToolNameForRendering({
            toolName: 'Run echo hello',
            toolInput: { _acp: { kind: 'execute' } },
            toolDescription: 'Run echo hello',
            knownToolKeys: known,
        });
        expect(result).toEqual({ normalizedToolName: 'execute', source: 'acpKind' });
    });

    it('can derive from toolDescription when it is a stable key', () => {
        const result = inferToolNameForRendering({
            toolName: 'unknown',
            toolInput: {},
            toolDescription: 'read',
            knownToolKeys: known,
        });
        expect(result).toEqual({ normalizedToolName: 'read', source: 'toolDescription' });
    });

    it('uses _acp.title as a fallback when it is a stable known key', () => {
        const result = inferToolNameForRendering({
            toolName: 'unknown',
            toolInput: { _acp: { title: 'TodoRead' } },
            toolDescription: null,
            knownToolKeys: known,
        });
        expect(result).toEqual({ normalizedToolName: 'TodoRead', source: 'acpTitle' });
    });

    it('does not infer from descriptions with spaces', () => {
        const result = inferToolNameForRendering({
            toolName: 'unknown',
            toolInput: {},
            toolDescription: 'run shell command',
            knownToolKeys: known,
        });
        expect(result).toEqual({ normalizedToolName: 'unknown', source: 'original' });
    });

    it('normalizes todoread to TodoRead via known tool keys', () => {
        const result = inferToolNameForRendering({
            toolName: 'todoread',
            toolInput: {},
            toolDescription: null,
            knownToolKeys: known,
        });
        expect(result).toEqual({ normalizedToolName: 'TodoRead', source: 'original' });
    });
});
