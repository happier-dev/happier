import { describe, expect, it } from 'vitest';

import { resolveWorkspaceFileReference } from './resolveWorkspaceFileReference';

describe('transcript workspace file references', () => {
    it('maps absolute workspace links to workspace-relative paths', () => {
        expect(resolveWorkspaceFileReference({
            url: '/Users/leeroy/project/src/index.ts',
            workspacePath: '/Users/leeroy/project',
        })).toEqual({ filePath: 'src/index.ts' });
    });

    it('accepts browser-expanded local paths when they still point inside the workspace', () => {
        expect(resolveWorkspaceFileReference({
            url: 'http://localhost:18829/Users/leeroy/project/src/index.ts:8',
            workspacePath: '/Users/leeroy/project',
        })).toEqual({
            filePath: 'src/index.ts',
            line: 8,
            anchor: { kind: 'line', filePath: 'src/index.ts', line: 8 },
        });
    });

    it('accepts loopback https origins when they point inside the workspace', () => {
        expect(resolveWorkspaceFileReference({
            url: 'https://127.0.0.1:18829/Users/leeroy/project/src/index.ts:8',
            workspacePath: '/Users/leeroy/project',
        })).toEqual({
            filePath: 'src/index.ts',
            line: 8,
            anchor: { kind: 'line', filePath: 'src/index.ts', line: 8 },
        });
    });

    it('maps relative workspace links and keeps terminal line anchors', () => {
        expect(resolveWorkspaceFileReference({
            url: 'src/index.ts:5:2',
            workspacePath: '/Users/leeroy/project',
        })).toEqual({
            filePath: 'src/index.ts',
            line: 5,
            column: 2,
            anchor: { kind: 'line', filePath: 'src/index.ts', line: 5 },
        });
    });

    it('maps terminal line ranges to workspace-relative paths', () => {
        expect(resolveWorkspaceFileReference({
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
        expect(resolveWorkspaceFileReference({
            url: '/Users/leeroy/project/src/index.ts#L5',
            workspacePath: '/Users/leeroy/project',
        })).toEqual({
            filePath: 'src/index.ts',
            line: 5,
            anchor: { kind: 'line', filePath: 'src/index.ts', line: 5 },
        });
        expect(resolveWorkspaceFileReference({
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
        expect(resolveWorkspaceFileReference({
            url: 'C:\\Users\\Alice\\project\\src\\index.ts',
            workspacePath: 'C:\\Users\\Alice\\project',
        })).toEqual({ filePath: 'src/index.ts' });
    });

    it('accepts browser-expanded Windows drive links with line anchors', () => {
        expect(resolveWorkspaceFileReference({
            url: 'http://localhost:18829/C:/Users/Alice/project/src/index.ts:12',
            workspacePath: 'C:\\Users\\Alice\\project',
        })).toEqual({
            filePath: 'src/index.ts',
            line: 12,
            anchor: { kind: 'line', filePath: 'src/index.ts', line: 12 },
        });
    });

    it('accepts file URL Windows drive links with line anchors', () => {
        expect(resolveWorkspaceFileReference({
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
        expect(resolveWorkspaceFileReference({
            url: 'file://Server/Share/project/src/index.ts',
            workspacePath: '\\\\server\\share\\project',
        })).toEqual({ filePath: 'src/index.ts' });
    });

    it('does not treat Windows sibling prefixes as workspace children', () => {
        expect(resolveWorkspaceFileReference({
            url: 'C:\\Users\\Alice\\project-other\\src\\index.ts',
            workspacePath: 'C:\\Users\\Alice\\project',
        })).toBeNull();
    });

    it('does not map paths outside the workspace', () => {
        expect(resolveWorkspaceFileReference({
            url: '/Users/leeroy/other/src/index.ts',
            workspacePath: '/Users/leeroy/project',
        })).toBeNull();
    });

    it('does not trust arbitrary https origins for local file navigation', () => {
        expect(resolveWorkspaceFileReference({
            url: 'https://example.com/Users/leeroy/project/src/index.ts:8',
            workspacePath: '/Users/leeroy/project',
        })).toBeNull();
    });
});

describe('transcript machine file references opt-in', () => {
    it.each([
        ['README.md:4', { filePath: 'README.md', line: 4, anchor: { kind: 'line', filePath: 'README.md', line: 4 } }],
        ['README.md:4:2', { filePath: 'README.md', line: 4, column: 2, anchor: { kind: 'line', filePath: 'README.md', line: 4 } }],
    ])('retains root-file line suffixes for %s', (url, expected) => {
        expect(resolveWorkspaceFileReference({ url, workspacePath: '/work/repo', allowOutsideWorkspace: true })).toEqual(expected);
    });

    it.each([
        ['/work/repo-task/.scratch/report.md', '/work/repo', '/work/repo-task/.scratch/report.md'],
        ['../artifacts/report.md', '/work/repo', '/work/repo/../artifacts/report.md'],
        ['file:///work/artifacts/report.md', '/work/repo', '/work/artifacts/report.md'],
        ['http://localhost:18829/work/artifacts/report.md', '/work/repo', '/work/artifacts/report.md'],
        ['C:\\Artifacts\\Report.md', 'C:\\Repo', 'C:/Artifacts/Report.md'],
        ['file:///D:/Artifacts/Report.md', 'C:\\Repo', 'D:/Artifacts/Report.md'],
        ['file://Server/Share/Artifacts/Report.md', '\\\\Server\\Share\\Repo', '//server/Share/Artifacts/Report.md'],
        ['/report.md', '/', 'report.md'],
    ])('resolves %s without widening rendered-document containment', (url, workspacePath, filePath) => {
        expect(resolveWorkspaceFileReference({ url, workspacePath, allowOutsideWorkspace: true })).toEqual({ filePath });
    });
    it('retains the absolute target in an outside line range until the opener selects its base', () => {
        const filePath = '/work/artifacts/report.md';
        expect(resolveWorkspaceFileReference({ url: filePath + '#L5-L8', workspacePath: '/work/repo', allowOutsideWorkspace: true }))
            .toEqual({ filePath, line: 5, endLine: 8, anchor: { kind: 'range', filePath, startLine: 5, endLine: 8 } });
    });
    it.each(['https://example.com/report.md', 'javascript:alert(1)', 'data:text/plain,report', 'mailto:user@example.com', '#L5', 'bad%00file.md'])(
        'does not reinterpret %s as a machine file', url => {
            expect(resolveWorkspaceFileReference({ url, workspacePath: '/work/repo', allowOutsideWorkspace: true })).toBeNull();
        },
    );
});
