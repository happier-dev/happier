import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './index.js';

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
    expect(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT).toBe('daemon.bulkTransfer.upload.init');
    expect(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK).toBe('daemon.bulkTransfer.upload.chunk');
    expect(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE).toBe('daemon.bulkTransfer.upload.finalize');
    expect(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT).toBe('daemon.bulkTransfer.upload.abort');
    expect(RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE).toBe('daemon.directTransfer.import.prepare');
    expect(RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT).toBe('daemon.directTransfer.import.abort');
    expect(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE).toBe('daemon.directTransfer.export.prepare');
    expect(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT).toBe('daemon.bulkTransfer.download.init');
    expect(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK).toBe('daemon.bulkTransfer.download.chunk');
    expect(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE).toBe('daemon.bulkTransfer.download.finalize');
    expect(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT).toBe('daemon.bulkTransfer.download.abort');
    expect(RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CAPABILITY_GET_V1).toBe(
      'daemon.bulkTransfer.composerMedia.capability.get.v1',
    );
    expect(RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM).toBe('daemon.bulkTransfer.composerMedia.claim');
    expect(RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE).toBe('daemon.bulkTransfer.composerMedia.release');
    expect('DAEMON_BULK_TRANSFER_UPLOAD_INIT' in RPC_METHODS).toBe(false);
    expect('DAEMON_BULK_TRANSFER_DOWNLOAD_INIT' in RPC_METHODS).toBe(false);

    // Guardrail: legacy undeployed session file/attachment transfer surfaces must not reappear
    // as method literals in the canonical RPC method table.
    const methodLiterals = Object.values(RPC_METHODS) as readonly string[];
    expect(methodLiterals.some((literal) => literal.startsWith('daemon.sessionFiles.'))).toBe(false);
    expect(methodLiterals.some((literal) => literal.startsWith('daemon.sessionAttachments.'))).toBe(false);
  });
});
