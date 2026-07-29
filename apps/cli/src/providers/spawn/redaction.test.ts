import { describe, expect, it, vi } from 'vitest';

import { createProviderRedactionLease } from './redaction';

describe('provider redaction lease', () => {
  it('redacts every exact registered value and drops them on idempotent cleanup', () => {
    const onClose = vi.fn();
    const lease = createProviderRedactionLease({
      values: ['raw-secret', 'Bearer raw-secret', 'supplement'],
      onClose,
    });

    expect(lease.redact('failed with Bearer raw-secret and supplement')).toBe('failed with [REDACTED] and [REDACTED]');
    lease.add(['late-value']);
    expect(lease.redact('late-value')).toBe('[REDACTED]');
    lease.close();
    lease.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(lease.redact('raw-secret')).toBe('raw-secret');
  });

  it('rejects empty values and redacts longer overlapping values first', () => {
    expect(() => createProviderRedactionLease({ values: [''] })).toThrow(/empty/i);
    const lease = createProviderRedactionLease({ values: ['token', 'Bearer token'] });
    expect(lease.redact('Bearer token token')).toBe('[REDACTED] [REDACTED]');
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
});
