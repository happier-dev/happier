import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

const state = vi.hoisted(() => ({
    directImportUploadCalls: [] as any[],
    preferredServerId: 'server-1' as string | null,
    activeServerId: 'active-server-1',
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineControlTargetForSession: () => ({ machineId: 'machine-1', basePath: '/repo', confidence: 'reachable' }),
}));

vi.mock('@/sync/domains/session/listing/sessionListLookupState', () => ({
    resolveSessionListPreferredServerIdFromState: (_state: unknown, _sessionId: string, fallbackServerId?: string | null) =>
        state.preferredServerId ?? fallbackServerId ?? null,
}));

const storageMock = createStorageModuleStub({
    storage: {
        getState: () => ({}),
    } as any,
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: state.activeServerId,
    }),
}));

vi.mock('../families/uploadSessionAttachmentFromReaderViaDirectImport', () => ({
    uploadSessionAttachmentFromReaderViaDirectImport: async (params: any) => {
        state.directImportUploadCalls.push(params);
        return { success: true, path: '/repo/file', sizeBytes: params.fileReader.sizeBytes, sha256: 'h' };
    },
}));

describe('daemonSessionAttachments', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('falls back to the active server when the preferred session scope is not hydrated yet', async () => {
        state.directImportUploadCalls = [];
        state.preferredServerId = null;
        state.activeServerId = 'active-server-1';

        const { uploadDaemonSessionAttachmentFromReader } = await import('../families/sessionAttachmentTransfers');
        const result = await uploadDaemonSessionAttachmentFromReader({
            sessionId: 's1',
            fileReader: {
                sizeBytes: 2,
                readBytes: async () => new Uint8Array(),
                close: async () => {},
            },
            request: {
                messageLocalId: 'm1',
                fileName: 'a.txt',
                sizeBytes: 2,
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.',
                vcsIgnoreStrategy: 'none',
                vcsIgnoreWritesEnabled: false,
            },
        });

        expect(result.success).toBe(true);
        expect(state.directImportUploadCalls).toHaveLength(1);
        expect(state.directImportUploadCalls[0]?.serverId).toBe('active-server-1');
    });

    it('prefers the stored owner server over the active server when both are available', async () => {
        state.directImportUploadCalls = [];
        state.preferredServerId = 'owner-server';
        state.activeServerId = 'active-server-1';

        const { uploadDaemonSessionAttachmentFromReader } = await import('../families/sessionAttachmentTransfers');
        const result = await uploadDaemonSessionAttachmentFromReader({
            sessionId: 's1',
            fileReader: {
                sizeBytes: 2,
                readBytes: async () => new Uint8Array(),
                close: async () => {},
            },
            request: {
                messageLocalId: 'm-owner',
                fileName: 'owner.txt',
                sizeBytes: 2,
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.',
                vcsIgnoreStrategy: 'none',
                vcsIgnoreWritesEnabled: false,
            },
        });

        expect(result.success).toBe(true);
        expect(state.directImportUploadCalls).toHaveLength(1);
        expect(state.directImportUploadCalls[0]?.serverId).toBe('owner-server');
    });

    it('routes workspace attachments through the shared workspace transfer caller', async () => {
        state.directImportUploadCalls = [];
        state.preferredServerId = 'server-1';

        const { uploadDaemonSessionAttachmentFromReader } = await import('../families/sessionAttachmentTransfers');
        const result = await uploadDaemonSessionAttachmentFromReader({
            sessionId: 's1',
            fileReader: {
                sizeBytes: 2,
                readBytes: async () => new Uint8Array(),
                close: async () => {},
            },
            request: {
                messageLocalId: 'm1',
                fileName: 'a.txt',
                sizeBytes: 2,
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.',
                vcsIgnoreStrategy: 'none',
                vcsIgnoreWritesEnabled: false,
            },
        });

        expect(result.success).toBe(true);
        expect(state.directImportUploadCalls).toHaveLength(1);
        expect(state.directImportUploadCalls[0]).toMatchObject({
            machineId: 'machine-1',
            serverId: 'server-1',
            request: {
                t: 'session_attachment_upload_v1',
                workingDirectory: '/repo',
                messageLocalId: 'm1',
                fileName: 'a.txt',
                sizeBytes: 2,
                uploadLocation: 'workspace',
                workspaceRootPath: '/repo',
                workspaceRelativeDir: '.',
                vcsIgnoreStrategy: 'none',
                vcsIgnoreWritesEnabled: false,
            },
        });
    });

    it('routes os_temp attachments through the shared workspace transfer caller without forcing a workspace root', async () => {
        state.directImportUploadCalls = [];
        state.preferredServerId = 'server-1';

        const { uploadDaemonSessionAttachmentFromReader } = await import('../families/sessionAttachmentTransfers');
        const result = await uploadDaemonSessionAttachmentFromReader({
            sessionId: 's1',
            fileReader: {
                sizeBytes: 3,
                readBytes: async () => new Uint8Array(),
                close: async () => {},
            },
            request: {
                messageLocalId: 'm2',
                fileName: 'b.txt',
                sizeBytes: 3,
                uploadLocation: 'os_temp',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'none',
                vcsIgnoreWritesEnabled: false,
            },
        });

        expect(result.success).toBe(true);
        expect(state.directImportUploadCalls).toHaveLength(1);
        expect(state.directImportUploadCalls[0]).toMatchObject({
            machineId: 'machine-1',
            serverId: 'server-1',
            request: {
                t: 'session_attachment_upload_v1',
                workingDirectory: '/repo',
                messageLocalId: 'm2',
                fileName: 'b.txt',
                sizeBytes: 3,
                uploadLocation: 'os_temp',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'none',
                vcsIgnoreWritesEnabled: false,
            },
        });
        expect(state.directImportUploadCalls[0]?.request?.workspaceRootPath).toBeUndefined();
    });

    it('passes the session workspace root to the attachment upload init request', async () => {
        state.directImportUploadCalls = [];
        state.preferredServerId = 'server-1';

        const { uploadDaemonSessionAttachmentFromReader } = await import('../families/sessionAttachmentTransfers');
        await uploadDaemonSessionAttachmentFromReader({
            sessionId: 's1',
            fileReader: {
                sizeBytes: 2,
                readBytes: async () => new Uint8Array(),
                close: async () => {},
            },
            request: {
                messageLocalId: 'm1',
                fileName: 'a.txt',
                sizeBytes: 2,
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'none',
                vcsIgnoreWritesEnabled: false,
            },
        });

        expect(state.directImportUploadCalls).toHaveLength(1);
        expect(state.directImportUploadCalls[0]?.request).toMatchObject({
            t: 'session_attachment_upload_v1',
            messageLocalId: 'm1',
            fileName: 'a.txt',
            workspaceRelativeDir: '.happier/uploads',
            workspaceRootPath: '/repo',
        });
    });
});
