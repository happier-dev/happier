import { describe, expect, it } from 'vitest';
import { resolveToolViewDetailLevel } from './resolveToolViewDetailLevel';

describe('resolveToolViewDetailLevel', () => {
    it('prefers per-tool overrides when present', () => {
        const level = resolveToolViewDetailLevel({
            toolName: 'Bash',
            toolInput: {},
            detailLevelDefault: 'summary',
            detailLevelDefaultLocalControl: 'title',
            detailLevelByToolName: { Bash: 'full' },
        });

        expect(level).toBe('full');
    });

    it('falls back to the local-control default when sessionMode=local_control', () => {
        const level = resolveToolViewDetailLevel({
            toolName: 'Read',
            toolInput: { _happy: { sessionMode: 'local_control' } },
            detailLevelDefault: 'summary',
            detailLevelDefaultLocalControl: 'title',
            detailLevelByToolName: {},
        });

        expect(level).toBe('title');
    });

    it('falls back to the global default otherwise', () => {
        const level = resolveToolViewDetailLevel({
            toolName: 'Edit',
            toolInput: {},
            detailLevelDefault: 'summary',
            detailLevelDefaultLocalControl: 'title',
            detailLevelByToolName: {},
        });

        expect(level).toBe('summary');
    });
});

