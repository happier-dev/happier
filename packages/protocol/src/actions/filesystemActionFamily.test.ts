import { describe, expect, it } from 'vitest';
import { FilesystemReadFileInputSchema, FilesystemReadFileOutputSchema, FilesystemWriteFileOutputSchema, FilesystemListDirectoryOutputSchema, FilesystemGetDirectoryTreeOutputSchema, FilesystemMutationOutputSchema } from './filesystemActionFamily.js';

describe('filesystem byte ranges', () => {
  it('preserves closed filesystem admission reasons across strict Action result readers', () => {
    for (const schema of [FilesystemReadFileOutputSchema, FilesystemWriteFileOutputSchema,
      FilesystemListDirectoryOutputSchema, FilesystemGetDirectoryTreeOutputSchema, FilesystemMutationOutputSchema]) {
      const failure = { success: false, error: 'Filesystem admission refused',
        errorCode: 'filesystem_identity_custody_unavailable', details: { reason: 'requester_identity_unavailable' } };
      expect(schema.parse(failure)).toEqual(failure);
      expect(schema.safeParse({ ...failure, details: { reason: 'unbounded_provider_prose' } }).success).toBe(false);
      expect(schema.safeParse({ ...failure, details: { ...failure.details, path: '/private' } }).success).toBe(false);
    }
  });
  it('accepts bounded byte ranges without allowing offset-only or invalid range inputs', () => {
    const input = { rootPath: '/workspace', path: 'large.log', offset: 17, length: 4 };
    expect(FilesystemReadFileInputSchema.parse(input)).toEqual(input);
    expect(FilesystemReadFileInputSchema.parse({ rootPath: '/workspace', path: 'large.log', length: 4 })).toMatchObject({ length: 4 });
    for (const range of [{ offset: 1 }, { offset: -1, length: 4 }, { offset: 0.5, length: 4 }, { length: 0 }, { length: 1.5 }]) {
      expect(FilesystemReadFileInputSchema.safeParse({ rootPath: '/workspace', path: 'large.log', ...range }).success).toBe(false);
    }
    expect(FilesystemReadFileOutputSchema.parse({ success: true, content: 'AAE=', sizeBytes: 38_000_000, eof: false }))
      .toEqual({ success: true, content: 'AAE=', sizeBytes: 38_000_000, eof: false });
  });
});
