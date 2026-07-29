import { describe, expect, it } from 'vitest';

import {
  redactBugReportSensitiveText,
  registerSensitiveDiagnosticValues,
} from './redaction.js';

describe('runtime diagnostic sensitive-value leases', () => {
  it('redacts exact non-token-shaped values only while a lease is active', () => {
    const value = 'provider-key-with-spaces and punctuation !';
    const lease = registerSensitiveDiagnosticValues([value]);
    try {
      expect(redactBugReportSensitiveText(`failed with ${value}`)).toBe('failed with [REDACTED]');
    } finally {
      lease.close();
    }
    expect(redactBugReportSensitiveText(`failed with ${value}`)).toBe(`failed with ${value}`);
  });

  it('reference-counts overlapping leases and makes close idempotent', () => {
    const value = 'same non-token-shaped provider credential';
    const first = registerSensitiveDiagnosticValues([value]);
    const second = registerSensitiveDiagnosticValues([value]);
    try {
      first.close();
      first.close();
      expect(redactBugReportSensitiveText(value)).toBe('[REDACTED]');
    } finally {
      first.close();
      second.close();
    }
    expect(redactBugReportSensitiveText(value)).toBe(value);
  });

  it('rejects empty values instead of turning every diagnostic into redacted text', () => {
    expect(() => registerSensitiveDiagnosticValues([''])).toThrow(/empty/u);
  });

  it('redacts JSON-escaped and URL-encoded representations of an exact value', () => {
    const value = 'provider "credential"\nwith spaces';
    const lease = registerSensitiveDiagnosticValues([value]);
    try {
      const jsonEscaped = JSON.stringify(value).slice(1, -1);
      expect(redactBugReportSensitiveText(`stderr=${jsonEscaped}`)).toBe('stderr=[REDACTED]');
      expect(redactBugReportSensitiveText(`query=${encodeURIComponent(value)}`)).toBe('query=[REDACTED]');
    } finally {
      lease.close();
    }
  });

  it('shares only an opaque controller across bundled module copies, never the raw value map', () => {
    const value = 'opaque registry provider credential';
    const lease = registerSensitiveDiagnosticValues([value]);
    try {
      const controller = Reflect.get(
        globalThis,
        Symbol.for('happier.protocol.sensitiveDiagnosticValues.v2'),
      ) as unknown;
      expect(controller).not.toBeInstanceOf(Map);
      expect(JSON.stringify(controller)).not.toContain(value);
    } finally {
      lease.close();
    }
  });
});
