import { z } from 'zod';
import { decodeBase64, encodeBase64 } from '../../../crypto/base64.js';

export const SESSION_SYSTEM_RECORD_VERSION_MAX = 2_147_483_647;

export const SessionSystemRecordRevisionSchema = z.string()
  .max(1_024)
  .refine((value) => value === value.trim(), 'Revision must already be trimmed')
  .regex(/^ssr1\.[A-Za-z0-9_-]+$/)
  .refine((value) => {
    const encoded = value.slice('ssr1.'.length);
    try {
      const bytes = decodeBase64(encoded, 'base64url');
      if (encodeBase64(bytes, 'base64url') !== encoded || bytes.byteLength < 9) return false;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const idLength = view.getUint32(0, false);
      if (idLength < 1 || idLength > 512 || bytes.byteLength !== 4 + idLength + 4) return false;
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + idLength));
      const version = view.getUint32(4 + idLength, false);
      return version >= 1 && version <= SESSION_SYSTEM_RECORD_VERSION_MAX;
    } catch {
      return false;
    }
  }, 'Invalid session system record revision');

export type SessionSystemRecordRevision = z.infer<typeof SessionSystemRecordRevisionSchema>;
