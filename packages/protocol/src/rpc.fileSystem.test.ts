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
    expect(RPC_METHODS.FILES_UPLOAD_INIT).toBe('files.upload.init');
    expect(RPC_METHODS.FILES_UPLOAD_CHUNK).toBe('files.upload.chunk');
    expect(RPC_METHODS.FILES_UPLOAD_FINALIZE).toBe('files.upload.finalize');
    expect(RPC_METHODS.FILES_UPLOAD_ABORT).toBe('files.upload.abort');
    expect(RPC_METHODS.FILES_DOWNLOAD_INIT).toBe('files.download.init');
    expect(RPC_METHODS.FILES_DOWNLOAD_CHUNK).toBe('files.download.chunk');
    expect(RPC_METHODS.FILES_DOWNLOAD_FINALIZE).toBe('files.download.finalize');
    expect(RPC_METHODS.FILES_DOWNLOAD_ABORT).toBe('files.download.abort');
    expect(RPC_METHODS.ATTACHMENTS_CONFIGURE).toBe('attachments.configure');
  });
});
