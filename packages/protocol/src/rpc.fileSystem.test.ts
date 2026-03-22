import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './rpc.js';

describe('RPC_METHODS file-system surface', () => {
  it('defines file-system method constants', () => {
    expect(RPC_METHODS.READ_FILE).toBe('readFile');
    expect(RPC_METHODS.WRITE_FILE).toBe('writeFile');
    expect(RPC_METHODS.CREATE_DIRECTORY).toBe('createDirectory');
    expect(RPC_METHODS.LIST_DIRECTORY).toBe('listDirectory');
    expect(RPC_METHODS.GET_DIRECTORY_TREE).toBe('getDirectoryTree');
    expect(RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS).toBe('daemon.filesystem.listRoots');
    expect(RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY).toBe('daemon.filesystem.listDirectory');
    expect(RPC_METHODS.STAT_FILE).toBe('statFile');
    expect(RPC_METHODS.RENAME_PATH).toBe('renamePath');
    expect(RPC_METHODS.DELETE_PATH).toBe('deletePath');
    expect(RPC_METHODS.DAEMON_SESSION_FILES_UPLOAD_INIT).toBe('daemon.sessionFiles.upload.init');
    expect(RPC_METHODS.DAEMON_SESSION_FILES_UPLOAD_CHUNK).toBe('daemon.sessionFiles.upload.chunk');
    expect(RPC_METHODS.DAEMON_SESSION_FILES_UPLOAD_FINALIZE).toBe('daemon.sessionFiles.upload.finalize');
    expect(RPC_METHODS.DAEMON_SESSION_FILES_UPLOAD_ABORT).toBe('daemon.sessionFiles.upload.abort');
    expect(RPC_METHODS.DAEMON_SESSION_FILES_DOWNLOAD_INIT).toBe('daemon.sessionFiles.download.init');
    expect(RPC_METHODS.DAEMON_SESSION_FILES_DOWNLOAD_CHUNK).toBe('daemon.sessionFiles.download.chunk');
    expect(RPC_METHODS.DAEMON_SESSION_FILES_DOWNLOAD_FINALIZE).toBe('daemon.sessionFiles.download.finalize');
    expect(RPC_METHODS.DAEMON_SESSION_FILES_DOWNLOAD_ABORT).toBe('daemon.sessionFiles.download.abort');
    expect(RPC_METHODS.DAEMON_SESSION_ATTACHMENTS_UPLOAD_INIT).toBe('daemon.sessionAttachments.upload.init');
    expect(RPC_METHODS.DAEMON_SESSION_ATTACHMENTS_UPLOAD_CHUNK).toBe('daemon.sessionAttachments.upload.chunk');
    expect(RPC_METHODS.DAEMON_SESSION_ATTACHMENTS_UPLOAD_FINALIZE).toBe('daemon.sessionAttachments.upload.finalize');
    expect(RPC_METHODS.DAEMON_SESSION_ATTACHMENTS_UPLOAD_ABORT).toBe('daemon.sessionAttachments.upload.abort');
    expect('FILES_UPLOAD_INIT' in RPC_METHODS).toBe(false);
    expect('FILES_UPLOAD_CHUNK' in RPC_METHODS).toBe(false);
    expect('FILES_UPLOAD_FINALIZE' in RPC_METHODS).toBe(false);
    expect('FILES_UPLOAD_ABORT' in RPC_METHODS).toBe(false);
    expect('FILES_DOWNLOAD_INIT' in RPC_METHODS).toBe(false);
    expect('FILES_DOWNLOAD_CHUNK' in RPC_METHODS).toBe(false);
    expect('FILES_DOWNLOAD_FINALIZE' in RPC_METHODS).toBe(false);
    expect('FILES_DOWNLOAD_ABORT' in RPC_METHODS).toBe(false);
    expect('ATTACHMENTS_CONFIGURE' in RPC_METHODS).toBe(false);
  });
});
