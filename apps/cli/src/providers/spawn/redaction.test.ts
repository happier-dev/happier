import { describe, expect, it, vi } from 'vitest';

import { createProviderRedactionLease } from './redaction';

describe('provider redaction lease', () => {
  it('reports original byte spans for masking before stream projections change their length', () => {
    const lease = createProviderRedactionLease({ values: ['sëcret', 'sëcret-value'] });
    const spans: { byteLength: number; redacted: boolean }[] = [];
    const stream = lease.createStreamingSanitizer((byteLength: number, redacted: boolean) => {
      spans.push({ byteLength, redacted });
    });
    const safe = Buffer.from('ok 猫 ');
    expect(Buffer.from(stream.pushBytes(Buffer.concat([safe, Buffer.from('së')])))).toEqual(safe);
    expect(spans).toEqual([{ byteLength: safe.byteLength, redacted: false }]);
    expect(stream.push('cret')).toBe('');
    expect(stream.flush()).toBe('[REDACTED]');
    expect(spans).toEqual([{ byteLength: safe.byteLength, redacted: false },
      { byteLength: Buffer.byteLength('sëcret'), redacted: true }]);
    lease.close();
  });

  it('delivers safe bytes immediately while retaining only a possible split secret', () => {
    const lease = createProviderRedactionLease({ values: ['selected-vercel-token'] });
    const stream = lease.createStreamingSanitizer();
    const frame = new TextEncoder().encode('{"message":"ready"}\n');

    expect(stream.pushBytes(frame)).toEqual(frame);
    expect(lease.isActive()).toBe(true);
    expect(stream.push('selected-vercel-')).toBe('');
    expect(stream.push('token\n')).toBe('[REDACTED]\n');
    expect(stream.flush()).toBe('');
    lease.close();
  });

  it('retains an ambiguous shorter secret until a longer overlapping secret is decided', () => {
    const stream = createProviderRedactionLease({ values: ['sëcret', 'sëcret-value'] }).createStreamingSanitizer();

    expect(stream.push('before sëcret')).toBe('before ');
    expect(stream.push('-value after')).toBe('[REDACTED] after');
    expect(stream.flush()).toBe('');
  });

  it('redacts every exact registered value and drops them on idempotent cleanup', () => {
    const onClose = vi.fn();
    const lease = createProviderRedactionLease({
      values: ['raw-secret', 'Bearer raw-secret', 'supplement'],
      onClose,
    });

    expect(lease.isActive()).toBe(true);
    expect(lease.redact('failed with Bearer raw-secret and supplement')).toBe('failed with [REDACTED] and [REDACTED]');
    lease.add(['late-value']);
    expect(lease.redact('late-value')).toBe('[REDACTED]');
    lease.close();
    lease.close();
    expect(lease.isActive()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lease.redact('raw-secret')).toBe('raw-secret');
  });

  it('rejects empty values and redacts longer overlapping values first', () => {
    expect(() => createProviderRedactionLease({ values: [''] })).toThrow(/empty/i);
    const lease = createProviderRedactionLease({ values: ['token', 'Bearer token'] });
    expect(lease.redact('Bearer token token')).toBe('[REDACTED] [REDACTED]');
  });

  it('detects raw, percent-encoded, and form-encoded registered values without exposing them', () => {
    const lease = createProviderRedactionLease({ values: ['raw secret/value'] });

    expect(lease.containsSensitiveValue('echo raw secret/value')).toBe(true);
    expect(lease.containsSensitiveValue('echo raw%20secret%2Fvalue')).toBe(true);
    expect(lease.containsSensitiveValue('echo raw+secret%2fvalue')).toBe(true);
    expect(lease.containsSensitiveValue('safe output')).toBe(false);
    lease.close();
    expect(lease.containsSensitiveValue('raw secret/value')).toBe(false);
  });

  it('creates a request-scope snapshot that remains safe while the credential lease closes', () => {
    const lease = createProviderRedactionLease({ values: ['secret-value'] });
    lease.add(['Bearer secret-value']);
    const requestRedactor = lease.snapshotRedactor();

    lease.close();

    expect(lease.redact('secret-value')).toBe('secret-value');
    expect(requestRedactor('cleanup echoed Bearer secret-value')).toBe('cleanup echoed [REDACTED]');
  });

  it.each(Array.from({ length: Buffer.byteLength('secret-value') - 1 }, (_, index) => index + 1))(
    'redacts a secret split at byte boundary %s in a streaming diagnostic',
    (splitAt) => {
      const lease = createProviderRedactionLease({ values: ['secret-value'] });
      const stream = lease.createStreamingSanitizer();
      const bytes = Buffer.from('before secret-value after', 'utf8');
      const secretOffset = Buffer.byteLength('before ');
      const chunks = [
        bytes.subarray(0, secretOffset + splitAt),
        bytes.subarray(secretOffset + splitAt),
      ];

      const rendered = `${stream.push(chunks[0]!)}${stream.push(chunks[1]!)}${stream.flush()}`;

      expect(rendered).toBe('before [REDACTED] after');
      expect(rendered).not.toContain('secret-value');
    },
  );

  it('redacts a value registered after stream creation when it is split across chunks', () => {
    const lease = createProviderRedactionLease({ values: ['initial-secret'] });
    const stream = lease.createStreamingSanitizer();
    lease.add(['late-secret']);
    const bytes = Buffer.from('before late-secret after', 'utf8');
    const splitAt = Buffer.byteLength('before late-', 'utf8');

    const rendered = `${stream.push(bytes.subarray(0, splitAt))}${stream.push(bytes.subarray(splitAt))}${stream.flush()}`;

    expect(rendered).toBe('before [REDACTED] after');
    expect(rendered).not.toContain('late-secret');
  });

  it('keeps UTF-8 decoding state and flushes an incomplete final sequence safely', () => {
    const lease = createProviderRedactionLease({ values: ['clé-secrète'] });
    const stream = lease.createStreamingSanitizer();
    const bytes = Buffer.from('pré clé-secrète fin', 'utf8');
    const splitAt = bytes.indexOf(Buffer.from('è')) + 1;

    const rendered = `${stream.push(bytes.subarray(0, splitAt))}${stream.push(bytes.subarray(splitAt))}${stream.flush()}`;

    expect(rendered).toBe('pré [REDACTED] fin');
  });

  it('redacts exact secrets with a leading UTF-8 BOM across byte chunks', () => {
    const secret = '\uFEFFsecret-sentinel';
    const bytes = Buffer.from(`${secret} PORT=3000 COMMIT=abc123`, 'utf8');

    for (const splitAt of [1, 2, 3, bytes.length]) {
      const lease = createProviderRedactionLease({ values: [secret] });
      const stream = lease.createStreamingSanitizer();
      const rendered = `${stream.push(bytes.subarray(0, splitAt))}${stream.push(bytes.subarray(splitAt))}${stream.flush()}`;

      expect(rendered).toBe('[REDACTED] PORT=3000 COMMIT=abc123');
      lease.close();
    }
  });
});
