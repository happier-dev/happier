import { describe, expect, it } from 'vitest';

import { resolveTranscriptMarkdownFileLink } from './resolveTranscriptMarkdownFileLink';

describe('resolveTranscriptMarkdownFileLink', () => {
    it('maps absolute workspace links to workspace-relative paths', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: '/Users/leeroy/project/src/index.ts',
            workspacePath: '/Users/leeroy/project',
        })).toEqual({ filePath: 'src/index.ts' });
    });

    it('accepts browser-expanded local paths when they still point inside the workspace', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: 'http://localhost:18829/Users/leeroy/project/src/index.ts:8',
            workspacePath: '/Users/leeroy/project',
        })).toEqual({
            filePath: 'src/index.ts',
            line: 8,
            anchor: { kind: 'line', filePath: 'src/index.ts', line: 8 },
        });
    });

    it('accepts loopback https origins when they point inside the workspace', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: 'https://127.0.0.1:18829/Users/leeroy/project/src/index.ts:8',
            workspacePath: '/Users/leeroy/project',
        })).toEqual({
            filePath: 'src/index.ts',
            line: 8,
            anchor: { kind: 'line', filePath: 'src/index.ts', line: 8 },
        });
    });

    it('maps relative workspace links and keeps terminal line anchors', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: 'src/index.ts:5:2',
            workspacePath: '/Users/leeroy/project',
        })).toEqual({
            filePath: 'src/index.ts',
            line: 5,
            column: 2,
            anchor: { kind: 'line', filePath: 'src/index.ts', line: 5 },
        });
    });

    it.each(['README.md', 'index.ts'])('preserves root-file line and column suffixes for %s', (filePath) => {
        expect(resolveTranscriptMarkdownFileLink({
            url: `${filePath}:4:2`,
            workspacePath: '/work/repo',
        })).toEqual({
            filePath, line: 4, column: 2,
            anchor: { kind: 'line', filePath, line: 4 },
        });
    });

    it('maps terminal line ranges to workspace-relative paths', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: 'src/index.ts:5-8',
            workspacePath: '/Users/leeroy/project',
        })).toEqual({
            filePath: 'src/index.ts',
            line: 5,
            endLine: 8,
            anchor: { kind: 'range', filePath: 'src/index.ts', startLine: 5, endLine: 8 },
        });
    });

    it('maps hash line anchors and ranges to workspace-relative paths', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: '/Users/leeroy/project/src/index.ts#L5',
            workspacePath: '/Users/leeroy/project',
        })).toEqual({
            filePath: 'src/index.ts',
            line: 5,
            anchor: { kind: 'line', filePath: 'src/index.ts', line: 5 },
        });
        expect(resolveTranscriptMarkdownFileLink({
            url: '/Users/leeroy/project/src/index.ts#L5-L8',
            workspacePath: '/Users/leeroy/project',
        })).toEqual({
            filePath: 'src/index.ts',
            line: 5,
            endLine: 8,
            anchor: { kind: 'range', filePath: 'src/index.ts', startLine: 5, endLine: 8 },
        });
    });

    it('maps Windows drive links to workspace-relative paths', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: 'C:\\Users\\Alice\\project\\src\\index.ts',
            workspacePath: 'C:\\Users\\Alice\\project',
        })).toEqual({ filePath: 'src/index.ts' });
    });

    it('accepts browser-expanded Windows drive links with line anchors', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: 'http://localhost:18829/C:/Users/Alice/project/src/index.ts:12',
            workspacePath: 'C:\\Users\\Alice\\project',
        })).toEqual({
            filePath: 'src/index.ts',
            line: 12,
            anchor: { kind: 'line', filePath: 'src/index.ts', line: 12 },
        });
    });

    it('accepts file URL Windows drive links with line anchors', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: 'file:///C:/Users/Alice/project/src/index.ts:12:4',
            workspacePath: 'C:\\Users\\Alice\\project',
        })).toEqual({
            filePath: 'src/index.ts',
            line: 12,
            column: 4,
            anchor: { kind: 'line', filePath: 'src/index.ts', line: 12 },
        });
    });

    it('maps UNC file URLs to workspace-relative paths', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: 'file://Server/Share/project/src/index.ts',
            workspacePath: '\\\\server\\share\\project',
        })).toEqual({ filePath: 'src/index.ts' });
    });

    it('keeps Windows sibling prefixes as absolute machine targets', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: 'C:\\Users\\Alice\\project-other\\src\\index.ts',
            workspacePath: 'C:\\Users\\Alice\\project',
        })).toEqual({ filePath: 'c:/users/alice/project-other/src/index.ts' });
    });

    it('preserves paths outside the workspace for the authenticated file service', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: '/Users/leeroy/other/src/index.ts',
            workspacePath: '/Users/leeroy/project',
        })).toEqual({ filePath: '/Users/leeroy/other/src/index.ts' });
    });

    it('preserves encoded spaces and line ranges on external artifact paths', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: '/work/artifacts/my%20report.md#L5-L8',
            workspacePath: '/work/repo',
        })).toEqual({
            filePath: '/work/artifacts/my report.md',
            line: 5,
            endLine: 8,
            anchor: { kind: 'range', filePath: '/work/artifacts/my report.md', startLine: 5, endLine: 8 },
        });
    });

    it('does not need a workspace root to identify an absolute machine path', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: '/work/artifacts/report.md',
            workspacePath: null,
        })).toEqual({ filePath: '/work/artifacts/report.md' });
    });

    it('resolves parent-relative links against the session workspace', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: '../repo-task/.scratch/report.md:4',
            workspacePath: '/work/repo',
        })).toEqual({
            filePath: '/work/repo/../repo-task/.scratch/report.md',
            line: 4,
            anchor: { kind: 'line', filePath: '/work/repo/../repo-task/.scratch/report.md', line: 4 },
        });
    });

    it.each(['javascript:alert(1)', 'mailto:user@example.com', 'ssh://host/report.md', '/work/bad%00.md'])(
        'does not turn an unsupported or malformed target into a file: %s', (url) => {
            expect(resolveTranscriptMarkdownFileLink({ url, workspacePath: '/work/repo' })).toBeNull();
        },
    );

    it('does not trust arbitrary https origins for local file navigation', () => {
        expect(resolveTranscriptMarkdownFileLink({
            url: 'https://example.com/Users/leeroy/project/src/index.ts:8',
            workspacePath: '/Users/leeroy/project',
        })).toBeNull();
    });
});
