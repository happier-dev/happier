import { describe, expect, it } from 'vitest';

import { DesktopPathMappingsSchema, resolveSessionLocalFilePath } from './localFilePath';

const SERVER_TO_SHARE = { remotePath: '/srv/projects', localPath: '\\\\fileserver\\fileserver\\PROJECTS' };

describe('resolveSessionLocalFilePath', () => {
    it('joins the workspace and file path when the session runs on this computer', () => {
        expect(resolveSessionLocalFilePath({
            workspacePath: '/home/developer/proj',
            homeDir: '/home/developer',
            relativePath: 'docs/readme.md',
            sessionOnThisComputer: true,
            mappings: [],
        })).toBe('/home/developer/proj/docs/readme.md');
    });

    it('keeps Windows separators for a Windows workspace on this computer', () => {
        expect(resolveSessionLocalFilePath({
            workspacePath: 'C:\\Users\\developer\\proj\\',
            homeDir: 'C:\\Users\\developer',
            relativePath: 'docs/readme.md',
            sessionOnThisComputer: true,
            mappings: [],
        })).toBe('C:\\Users\\developer\\proj\\docs\\readme.md');
    });

    it('expands a home-relative workspace with the machine home directory', () => {
        expect(resolveSessionLocalFilePath({
            workspacePath: '~/proj',
            homeDir: '/Users/developer',
            relativePath: 'a.md',
            sessionOnThisComputer: true,
            mappings: [],
        })).toBe('/Users/developer/proj/a.md');
    });

    it('returns null when a home-relative workspace cannot be expanded', () => {
        expect(resolveSessionLocalFilePath({
            workspacePath: '~/proj',
            homeDir: null,
            relativePath: 'a.md',
            sessionOnThisComputer: true,
            mappings: [],
        })).toBeNull();
    });

    it('maps a file on another machine onto the shared folder of this computer', () => {
        expect(resolveSessionLocalFilePath({
            workspacePath: '/srv/projects/TEAM/APP',
            homeDir: '/home/developer',
            relativePath: 'notes/NOTES.md',
            sessionOnThisComputer: false,
            mappings: [SERVER_TO_SHARE],
        })).toBe('\\\\fileserver\\fileserver\\PROJECTS\\TEAM\\APP\\notes\\NOTES.md');
    });

    it('maps onto a POSIX folder with forward slashes', () => {
        expect(resolveSessionLocalFilePath({
            workspacePath: '/srv/work/app',
            homeDir: null,
            relativePath: 'a.md',
            sessionOnThisComputer: false,
            mappings: [{ remotePath: '/srv/work/', localPath: '/Volumes/work/' }],
        })).toBe('/Volumes/work/app/a.md');
    });

    it('does not match a sibling folder that only shares a name prefix', () => {
        expect(resolveSessionLocalFilePath({
            workspacePath: '/srv/projects-old/app',
            homeDir: null,
            relativePath: 'a.md',
            sessionOnThisComputer: false,
            mappings: [SERVER_TO_SHARE],
        })).toBeNull();
    });

    it('uses the most specific mapping when several match', () => {
        expect(resolveSessionLocalFilePath({
            workspacePath: '/srv/projects/TEAM/app',
            homeDir: null,
            relativePath: 'a.md',
            sessionOnThisComputer: false,
            mappings: [SERVER_TO_SHARE, { remotePath: '/srv/projects/TEAM', localPath: 'D:\\developer' }],
        })).toBe('D:\\developer\\app\\a.md');
    });

    it('maps the mapped folder itself', () => {
        expect(resolveSessionLocalFilePath({
            workspacePath: '/srv/projects',
            homeDir: null,
            relativePath: 'top.md',
            sessionOnThisComputer: false,
            mappings: [SERVER_TO_SHARE],
        })).toBe('\\\\fileserver\\fileserver\\PROJECTS\\top.md');
    });

    it('returns null for a file on another machine with no matching mapping', () => {
        expect(resolveSessionLocalFilePath({
            workspacePath: '/home/developer/app',
            homeDir: '/home/developer',
            relativePath: 'a.md',
            sessionOnThisComputer: false,
            mappings: [SERVER_TO_SHARE],
        })).toBeNull();
    });

    it('returns null without a workspace path', () => {
        expect(resolveSessionLocalFilePath({
            workspacePath: null,
            homeDir: null,
            relativePath: 'a.md',
            sessionOnThisComputer: true,
            mappings: [],
        })).toBeNull();
    });
});

describe('DesktopPathMappingsSchema', () => {
    it('drops malformed stored entries instead of discarding every mapping', () => {
        expect(DesktopPathMappingsSchema.parse([
            SERVER_TO_SHARE,
            { remotePath: '', localPath: 'x' },
            'junk',
        ])).toEqual([SERVER_TO_SHARE]);
    });
});

it('matches Windows source mappings without case sensitivity', () => {
    expect(resolveSessionLocalFilePath({
        workspacePath: 'C:/Work/app',
        homeDir: null,
        relativePath: 'a.md',
        sessionOnThisComputer: false,
        mappings: [{ remotePath: 'c:/work', localPath: '/mnt/shared' }],
    })).toBe('/mnt/shared/app/a.md');
});
