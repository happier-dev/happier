import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const protocol = await import('../index.js');

describe('workspace manifest schemas', () => {
  it('exports canonical manifest schemas from the protocol root', async () => {
    expect(protocol).toHaveProperty('WorkspaceManifestEntryKindSchema');
    expect(protocol).toHaveProperty('WorkspaceManifestEntrySchema');
    expect(protocol).toHaveProperty('WorkspaceManifestFingerprintSchema');
    expect(protocol).toHaveProperty('WorkspaceManifestSchema');
  });

  it('accepts canonical directory, file, and symlink manifest entries with an optional manifest fingerprint', async () => {
    const entrySchema = protocol.WorkspaceManifestEntrySchema as z.ZodTypeAny;
    const manifestSchema = protocol.WorkspaceManifestSchema as z.ZodTypeAny;

    expect(entrySchema.safeParse({
      relativePath: 'src',
      kind: 'directory',
    }).success).toBe(true);

    expect(entrySchema.safeParse({
      relativePath: 'bin/run.sh',
      kind: 'file',
      digest: 'sha256:306c6ca7407560340797866e077e053627ad409277d1b9da58106fce4cf717cb',
      sizeBytes: 17,
      executable: true,
    }).success).toBe(true);

    expect(entrySchema.safeParse({
      relativePath: 'current',
      kind: 'symlink',
      target: './releases/current',
    }).success).toBe(true);

    expect(manifestSchema.safeParse({
      entries: [{
        relativePath: 'README.md',
        kind: 'file',
        digest: 'sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
        sizeBytes: 6,
        executable: false,
      }],
      fingerprint: 'sha256:ecc9071a7df045ba58e5f2b770556771fdb62fd37cb1f69d6ff5cc870e6d644e',
    }).success).toBe(true);
  });

  it('rejects malformed manifest fingerprints and cross-kind entry payloads', async () => {
    const entrySchema = protocol.WorkspaceManifestEntrySchema as z.ZodTypeAny;
    const manifestSchema = protocol.WorkspaceManifestSchema as z.ZodTypeAny;

    const badDirectoryEntry = entrySchema.safeParse({
      relativePath: 'src',
      kind: 'directory',
      digest: 'sha256:unexpected',
    });
    expect(badDirectoryEntry.success).toBe(false);

    const badFingerprint = manifestSchema.safeParse({
      entries: [],
      fingerprint: 'sha256:not-a-real-hex-digest',
    });
    expect(badFingerprint.success).toBe(false);
  });

  it('rejects Windows-style upward traversal segments in manifest paths', async () => {
    const entrySchema = protocol.WorkspaceManifestEntrySchema as z.ZodTypeAny;

    const escaped = entrySchema.safeParse({
      relativePath: 'src\\..\\secret.txt',
      kind: 'file',
      digest: 'sha256:306c6ca7407560340797866e077e053627ad409277d1b9da58106fce4cf717cb',
      sizeBytes: 17,
      executable: false,
    });

    expect(escaped.success).toBe(false);
  });

  it('rejects Windows absolute paths in manifest entries', async () => {
    const entrySchema = protocol.WorkspaceManifestEntrySchema as z.ZodTypeAny;

    expect(entrySchema.safeParse({
      relativePath: 'C:\\repo\\secret.txt',
      kind: 'file',
      digest: 'sha256:306c6ca7407560340797866e077e053627ad409277d1b9da58106fce4cf717cb',
      sizeBytes: 17,
      executable: false,
    }).success).toBe(false);

    expect(entrySchema.safeParse({
      relativePath: 'C:/repo/secret.txt',
      kind: 'file',
      digest: 'sha256:306c6ca7407560340797866e077e053627ad409277d1b9da58106fce4cf717cb',
      sizeBytes: 17,
      executable: false,
    }).success).toBe(false);
  });
});
