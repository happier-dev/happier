import { describe, expect, it } from 'vitest';
import { SessionAttachmentUploadInitRequestV1Schema } from './index.js';

describe('transferSessions schemas', () => {
  it('admits only explicitly Session-bound attachment uploads through the public schema', () => {
    const schema = SessionAttachmentUploadInitRequestV1Schema;
    const request = {
      t: 'session_attachment_upload_v1',
      sessionId: 'session-a',
      messageLocalId: 'message-a',
      fileName: 'notes.txt',
      sizeBytes: 3,
      uploadLocation: 'workspace',
      workspaceRelativeDir: '.happier/attachments',
      vcsIgnoreStrategy: 'none',
      vcsIgnoreWritesEnabled: false,
    };
    expect(schema.safeParse(request)).toMatchObject({ success: true, data: request });
    expect(schema.safeParse({ ...request, sessionId: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...request, sessionId: ' session-a ' }).success).toBe(false);
    expect(schema.safeParse({ ...request, callerAuthority: 'present_user' }).success).toBe(false);
  });

  it('accepts import and export session open responses with bounded, strict shapes', async () => {
    const mod = await import('./index.js');

    const importResult = mod.TransferSessionImportOpenResponseSchema.safeParse({
      protocolVersion: 1,
      kind: 'import',
      sessionId: 'transfer_session_import_1',
      chunkSizeBytes: 64 * 1024,
      expiresAt: 1_000,
      recipientPublicKeyBase64: Buffer.from('recipient-public-key', 'utf8').toString('base64'),
      scopeFingerprint: 'fingerprint-a',
      limits: {
        maxBytes: 1024,
        maxChunks: 16,
      },
    });

    expect(importResult.success).toBe(true);

    const exportResult = mod.TransferSessionExportOpenResponseSchema.safeParse({
      protocolVersion: 1,
      kind: 'export',
      sessionId: 'transfer_session_export_1',
      chunkSizeBytes: 64 * 1024,
      expiresAt: 1_000,
      manifestHash: 'sha256:abc123',
      totalChunks: 4,
      scopeFingerprint: 'fingerprint-b',
    });

    expect(exportResult.success).toBe(true);
  });

  it('rejects invalid transfer session open payloads', async () => {
    const mod = await import('./index.js');

    expect(mod.TransferSessionImportOpenResponseSchema.safeParse({
      protocolVersion: 1,
      kind: 'import',
      sessionId: '',
      chunkSizeBytes: 0,
      expiresAt: -1,
      recipientPublicKeyBase64: 'not-base64',
    }).success).toBe(false);

    expect(mod.TransferSessionExportOpenResponseSchema.safeParse({
      protocolVersion: 1,
      kind: 'export',
      sessionId: 'transfer_session_export_2',
      chunkSizeBytes: 64 * 1024,
      expiresAt: 1_000,
      manifestHash: 'sha256:abc123',
      totalChunks: 0,
      extraKey: 'nope',
    }).success).toBe(false);
  });

  it('exposes the shared transfer chunk envelope surface for session payloads', async () => {
    const mod = await import('./index.js');

    expect(mod.TransferSessionChunkEnvelopeSchema.safeParse({
      transferId: 'transfer_1',
      kind: 'chunk',
      sequence: 0,
      payloadBase64: 'YQ==',
      encryptedDataKeyEnvelopeBase64: Buffer.from('data-key', 'utf8').toString('base64'),
    }).success).toBe(true);
  });
});
