import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDaytonaContextFile, signDaytonaStoragePut } from './buildContext.js';

describe('Daytona native build context', () => {
  it('emits a standard tar that preserves binary content and nested long paths', () => {
    const directory = mkdtempSync(join(tmpdir(), 'daytona-context-'));
    const path = 'nested/'.repeat(20) + 'payload.tar.gz';
    const bytes = Uint8Array.of(0, 1, 2, 127, 128, 255);
    try {
      const context = createDaytonaContextFile({ path, contentsBase64: Buffer.from(bytes).toString('base64') });
      // MD5(archivePath UTF-8 + file bytes), independently calculated with Python hashlib.
      expect(context.hash).toBe('cd8978b4156bdf9bd351d9823921cfc0');
      const archive = join(directory, 'context.tar');
      writeFileSync(archive, context.bytes);
      // Use the platform tar reader, never a parser copied from the encoder.
      expect(execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim()).toBe(path);
      expect(new Uint8Array(execFileSync('tar', ['-xOf', archive, path]))).toEqual(bytes);
      expect(createDaytonaContextFile({ path: 'other.tar.gz', contentsBase64: Buffer.from(bytes).toString('base64') }).hash).not.toBe(context.hash);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('matches the published AWS S3 full-payload PUT signing vector', () => {
    // Public example credentials/vector, not tenant material:
    // https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
    const headers = signDaytonaStoragePut({ url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
      body: new TextEncoder().encode('Welcome to Amazon S3.'), at: new Date('2013-05-24T00:00:00Z'),
      credentials: { accessKey: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' },
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    });
    expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,'
      + 'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,'
      + 'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
    expect(headers['x-amz-content-sha256']).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
  });

  it('signs the runtime temporary session token without exposing the secret key', () => {
    const input = { url: new URL('https://storage.example/bucket/org/hash/context.tar'), body: Uint8Array.of(0, 255),
      at: new Date('2026-11-15T00:00:00Z'), credentials: { accessKey: 'temporary-key', secret: 'temporary-secret', sessionToken: 'temporary-session', region: 'us-east-1' } };
    const headers = signDaytonaStoragePut(input);
    expect(headers['x-amz-security-token']).toBe('temporary-session');
    expect(headers.authorization).toContain('x-amz-security-token');
    expect(headers.authorization).not.toBe(signDaytonaStoragePut({ ...input, credentials: { ...input.credentials, sessionToken: 'other-session' } }).authorization);
    expect(JSON.stringify(headers)).not.toContain('temporary-secret');
  });
});
