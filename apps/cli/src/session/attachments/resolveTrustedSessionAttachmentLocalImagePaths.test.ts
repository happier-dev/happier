import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import {
  SESSION_ATTACHMENT_FILE_EXCEEDS_UPLOAD_LIMIT,
  readTrustedSessionAttachmentLocalImages,
} from './resolveTrustedSessionAttachmentLocalImagePaths';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(),
  };
});

function mockOpenedFile(content: Buffer, statSize = content.byteLength) {
  const read = vi.fn(async (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    const chunk = content.subarray(position, position + length);
    chunk.copy(buffer, offset);
    return { bytesRead: chunk.byteLength, buffer };
  });
  const close = vi.fn(async () => undefined);
  vi.mocked(open).mockResolvedValue({
    stat: vi.fn(async () => ({ isFile: () => true, size: statSize })),
    read,
    close,
  } as unknown as Awaited<ReturnType<typeof open>>);
  return { read, close };
}

describe('readTrustedSessionAttachmentLocalImages', () => {
  beforeEach(() => {
    vi.mocked(open).mockReset();
  });

  it('rejects bytes whose read length differs from the declared and statted upload size', async () => {
    const declaredSizeBytes = 4;
    const replacementBytes = Buffer.from([1, 2, 3]);
    const uploadPath = '.happier/uploads/messages/message-1/screen.png';
    mockOpenedFile(replacementBytes, declaredSizeBytes);

    const trusted = await readTrustedSessionAttachmentLocalImages({
      cwd: '/workspace',
      metadata: {
        happier: {
          kind: 'attachments.v1',
          payload: {
            attachments: [{
              path: uploadPath,
              mimeType: 'image/png',
              sizeBytes: declaredSizeBytes,
              sha256: createHash('sha256').update(replacementBytes).digest('hex'),
            }],
          },
        },
        happierStructuredInputV1: {
          v: 1,
          imageInputs: [{
            kind: 'image',
            path: uploadPath,
            mimeType: 'image/png',
            provenance: { kind: 'sessionAttachmentUpload' },
          }],
        },
      },
    });

    expect(trusted).toEqual(new Map());
  });

  it('fails with a stable code before reading an upload beyond the configured file-upload limit', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const uploadPath = '.happier/uploads/messages/message-1/screen.png';
    vi.stubEnv('HAPPIER_FILES_IMAGE_READ_MAX_BYTES', String(bytes.byteLength - 1));
    reloadConfiguration();
    const opened = mockOpenedFile(bytes);

    await expect(readTrustedSessionAttachmentLocalImages({
      cwd: '/workspace',
      metadata: {
        happier: {
          kind: 'attachments.v1',
          payload: {
            attachments: [{
              path: uploadPath,
              mimeType: 'image/png',
              sizeBytes: bytes.byteLength,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            }],
          },
        },
        happierStructuredInputV1: {
          v: 1,
          imageInputs: [{
            kind: 'image',
            path: uploadPath,
            mimeType: 'image/png',
            provenance: { kind: 'sessionAttachmentUpload' },
          }],
        },
      },
    })).rejects.toMatchObject({
      code: SESSION_ATTACHMENT_FILE_EXCEEDS_UPLOAD_LIMIT,
    });

    expect(opened.read).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    reloadConfiguration();
  });

  it('bounds the open-handle read when a verified upload grows after stat', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const uploadPath = '.happier/uploads/messages/message-1/screen.png';
    vi.stubEnv('HAPPIER_FILES_IMAGE_READ_MAX_BYTES', String(bytes.byteLength - 1));
    reloadConfiguration();
    const opened = mockOpenedFile(bytes, bytes.byteLength - 1);

    await expect(readTrustedSessionAttachmentLocalImages({
      cwd: '/workspace',
      metadata: {
        happier: {
          kind: 'attachments.v1',
          payload: {
            attachments: [{
              path: uploadPath,
              mimeType: 'image/png',
              sizeBytes: bytes.byteLength - 1,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            }],
          },
        },
        happierStructuredInputV1: {
          v: 1,
          imageInputs: [{
            kind: 'image',
            path: uploadPath,
            mimeType: 'image/png',
            provenance: { kind: 'sessionAttachmentUpload' },
          }],
        },
      },
    })).rejects.toMatchObject({
      code: SESSION_ATTACHMENT_FILE_EXCEEDS_UPLOAD_LIMIT,
    });

    expect(opened.read).toHaveBeenCalledWith(expect.any(Buffer), 0, bytes.byteLength, 0);
    vi.unstubAllEnvs();
    reloadConfiguration();
  });
});
