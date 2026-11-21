import { describe, expect, it } from 'vitest';

import {
    buildNewSessionTargetFolder,
    readNewSessionTargetFolder,
    resolveCreatedSessionTargetFolder,
    type NewSessionTargetFolderV1,
} from './newSessionTargetFolder';

const FOLDER: NewSessionTargetFolderV1 = {
    folderId: 'folder_a',
    workspace: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
};

describe('buildNewSessionTargetFolder', () => {
    it('keeps the folder when every workspace scope component is present', () => {
        expect(buildNewSessionTargetFolder({
            folderId: ' folder_a ',
            serverId: 'server_a',
            machineId: 'machine_a',
            rootPath: '/repo',
        })).toEqual({
            folderId: 'folder_a',
            workspace: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
        });
    });

    it('drops an incomplete folder scope', () => {
        expect(buildNewSessionTargetFolder({
            folderId: 'folder_a',
            serverId: '',
            machineId: 'machine_a',
            rootPath: '/repo',
        })).toBeNull();
        expect(buildNewSessionTargetFolder({
            folderId: '',
            serverId: 'server_a',
            machineId: 'machine_a',
            rootPath: '/repo',
        })).toBeNull();
    });
});

describe('resolveCreatedSessionTargetFolder', () => {
    it('files the session when it launched in the folder workspace', () => {
        expect(resolveCreatedSessionTargetFolder({
            targetFolder: FOLDER,
            serverId: 'server_a',
            machineId: 'machine_a',
            directory: '/repo/',
        })).toEqual({
            folderId: 'folder_a',
            workspace: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
        });
    });

    it('ignores a launch that moved to another machine, directory or server', () => {
        for (const launch of [
            { serverId: 'server_b', machineId: 'machine_a', directory: '/repo' },
            { serverId: 'server_a', machineId: 'machine_b', directory: '/repo' },
            { serverId: 'server_a', machineId: 'machine_a', directory: '/elsewhere' },
        ]) {
            expect(resolveCreatedSessionTargetFolder({ targetFolder: FOLDER, ...launch })).toBeNull();
        }
    });

    it('compares Windows paths case-insensitively', () => {
        expect(resolveCreatedSessionTargetFolder({
            targetFolder: {
                folderId: 'folder_a',
                workspace: { serverId: 'server_a', machineId: 'machine_a', rootPath: 'C:\\Repo' },
            },
            serverId: 'server_a',
            machineId: 'machine_a',
            directory: 'c:/repo',
        })).toEqual({
            folderId: 'folder_a',
            workspace: { serverId: 'server_a', machineId: 'machine_a', rootPath: 'c:/repo' },
        });
    });

    it('does nothing without a target folder', () => {
        expect(resolveCreatedSessionTargetFolder({
            targetFolder: null,
            serverId: 'server_a',
            machineId: 'machine_a',
            directory: '/repo',
        })).toBeNull();
    });
});

describe('readNewSessionTargetFolder', () => {
    it('restores a folder staged with a draft', () => {
        expect(readNewSessionTargetFolder({
            folderId: 'folder_a',
            workspace: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
        })).toEqual(FOLDER);
    });

    it('drops malformed persisted values', () => {
        expect(readNewSessionTargetFolder(null)).toBeNull();
        expect(readNewSessionTargetFolder('folder_a')).toBeNull();
        expect(readNewSessionTargetFolder({ folderId: 'folder_a' })).toBeNull();
        expect(readNewSessionTargetFolder({
            folderId: 'folder_a',
            workspace: { serverId: 'server_a', machineId: '', rootPath: '/repo' },
        })).toBeNull();
    });
});
