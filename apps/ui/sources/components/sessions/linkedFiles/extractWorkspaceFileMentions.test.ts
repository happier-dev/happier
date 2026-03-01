import { describe, expect, it } from 'vitest';
import { extractWorkspaceFileMentions } from './extractWorkspaceFileMentions';

describe('extractWorkspaceFileMentions', () => {
    it('extracts unique @file paths in order', () => {
        expect(extractWorkspaceFileMentions('Check @src/api.ts and @README.md')).toEqual(['src/api.ts', 'README.md']);
    });

    it('trims trailing punctuation', () => {
        expect(extractWorkspaceFileMentions('See (@src/api.ts), then @src/cli.ts.')).toEqual(['src/api.ts', 'src/cli.ts']);
    });

    it('ignores @happier structured message prefixes', () => {
        expect(extractWorkspaceFileMentions('@happier/review.comments then @src/api.ts')).toEqual(['src/api.ts']);
    });

    it('ignores non-path mentions', () => {
        expect(extractWorkspaceFileMentions('Thanks @bob for the help')).toEqual([]);
    });

    it('rejects absolute and traversal paths', () => {
        expect(extractWorkspaceFileMentions('nope @../secrets.txt')).toEqual([]);
        expect(extractWorkspaceFileMentions('nope @src/../../secrets.txt')).toEqual([]);
        expect(extractWorkspaceFileMentions('nope @/etc/passwd')).toEqual([]);
        expect(extractWorkspaceFileMentions('nope @~/.ssh/id_rsa')).toEqual([]);
        expect(extractWorkspaceFileMentions('ok @src/api.ts')).toEqual(['src/api.ts']);
    });
});
