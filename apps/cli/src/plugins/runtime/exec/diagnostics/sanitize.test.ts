import { describe, expect, it } from 'vitest';
import { registerSensitiveDiagnosticValues } from '@happier-dev/protocol';

import {
  CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER,
  CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER,
} from '@/daemon/connectedServices/runtimeAuth/sensitiveConnectedServiceDiagnosticFields';

import { sanitizeExecDiagnosticText } from '../errors';
import { sanitizeRpcDiagnosticValue } from './sanitize';

describe('sanitizeRpcDiagnosticValue', () => {
  it('projects connected-service resume and local-path fields before support diagnostics export them', () => {
    expect(sanitizeRpcDiagnosticValue({
      vendorResumeId: 'vendor-session-private-123',
      cwd: '/Users/alice/private-project',
      targetMaterializedRoot: 'C:\\Users\\alice\\.happier\\materialized\\pi',
    })).toEqual({
      vendorResumeId: CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER,
      cwd: CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER,
      targetMaterializedRoot: CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER,
    });
  });

    it('applies the active child-runtime exact-value lease to nested plugin exec diagnostics', () => {
        const credential = 'nested exec provider credential with spaces !';
        const lease = registerSensitiveDiagnosticValues([credential]);
        try {
            expect(sanitizeRpcDiagnosticValue({
                error: {
                    stderr: `provider rejected ${credential}`,
                },
            })).toEqual({
                error: {
                    stderr: 'provider rejected [REDACTED]',
                },
            });
        } finally {
            lease.close();
        }
    });

  it('preserves repeated sibling objects instead of labeling them circular', () => {
    const repeated = { state: 'ready' };

    expect(sanitizeRpcDiagnosticValue({ first: repeated, second: repeated })).toEqual({
      first: { state: 'ready' },
      second: { state: 'ready' },
    });
  });

  it('keeps the diagnostic head on a UTF-8 character boundary after redaction', () => {
    const maximumBytes = 2_000;
    const sanitized = sanitizeRpcDiagnosticValue({
      client_secret: 'rpc-diagnostic-secret',
      stdout: `${'a'.repeat(maximumBytes - 1)}🙂`,
    }, { maxStringBytes: maximumBytes }) as Readonly<{
      client_secret: string;
      stdout: Readonly<{
        __happierRpcDiagnosticTruncated: true;
        originalType: 'string';
        originalBytes: number;
        value: string;
      }>;
    }>;

    expect(sanitized.client_secret).toBe('[REDACTED]');
    expect(sanitized.stdout).toMatchObject({
      __happierRpcDiagnosticTruncated: true,
      originalType: 'string',
      originalBytes: maximumBytes + 3,
    });
    expect(sanitized.stdout.value).toBe('a'.repeat(maximumBytes - 1));
    expect(sanitized.stdout.value).not.toContain('\uFFFD');
    expect(Buffer.byteLength(sanitized.stdout.value, 'utf8')).toBeLessThanOrEqual(maximumBytes);
  });

  it('redacts and bounds plain exec diagnostic text on a UTF-8 character boundary', () => {
    const maximumBytes = 2_000;
    const credential = 'exec-diagnostic-credential';
    const redactedPrefix = 'token=[REDACTED] ';
    const head = `${redactedPrefix}${'a'.repeat(maximumBytes - Buffer.byteLength(redactedPrefix, 'utf8') - 1)}`;
    const lease = registerSensitiveDiagnosticValues([credential]);
    try {
      const sanitized = sanitizeExecDiagnosticText(
        `token=${credential}; ${'a'.repeat(maximumBytes - Buffer.byteLength(redactedPrefix, 'utf8') - 1)}🙂`,
        maximumBytes,
      );

      expect(sanitized).toBe(head);
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).not.toContain(credential);
      expect(sanitized).not.toContain('\uFFFD');
      expect(Buffer.byteLength(sanitized, 'utf8')).toBeLessThanOrEqual(maximumBytes);
    } finally {
      lease.close();
    }
  });
});
