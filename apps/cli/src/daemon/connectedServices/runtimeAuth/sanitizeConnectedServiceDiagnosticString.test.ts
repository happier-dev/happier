import { describe, expect, it } from 'vitest';

import {
  CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER,
  CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER,
  CONNECTED_SERVICE_SECRET_REDACTION_MARKER,
} from './sensitiveConnectedServiceDiagnosticFields';
import { sanitizeConnectedServiceDiagnosticString } from './sanitizeConnectedServiceDiagnosticString';

describe('sanitizeConnectedServiceDiagnosticString', () => {
  it('preserves current secret redaction for assignments, bearer tokens, known values, and token-like values', () => {
    const knownSecret = 'known-provider-secret-value';
    const sanitized = sanitizeConnectedServiceDiagnosticString(
      [
        `authorization=Bearer raw-auth-token`,
        `refreshToken=raw-refresh-token`,
        `known=${knownSecret}`,
        `apiKey=sk-provider-test-secret`,
        `jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature`,
      ].join(' '),
      { redactedValues: [knownSecret] },
    );

    expect(sanitized).not.toContain('raw-auth-token');
    expect(sanitized).not.toContain('raw-refresh-token');
    expect(sanitized).not.toContain(knownSecret);
    expect(sanitized).not.toContain('sk-provider-test-secret');
    expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(sanitized).toContain(CONNECTED_SERVICE_SECRET_REDACTION_MARKER);
  });

  it('redacts provider resume id assignments without dropping the surrounding diagnostic shape', () => {
    const sanitized = sanitizeConnectedServiceDiagnosticString([
      'codexSessionId="019e5f08-3b44-72f3-8d73-a137dca3a47d"',
      'vendor_resume_id=pi-session-1',
      'CODEX_THREAD_ID=thread_123456789',
    ].join(' '));

    expect(sanitized).toContain(`codexSessionId=${CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER}`);
    expect(sanitized).toContain(`vendor_resume_id=${CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER}`);
    expect(sanitized).toContain(`CODEX_THREAD_ID=${CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER}`);
    expect(sanitized).not.toContain('019e5f08');
    expect(sanitized).not.toContain('pi-session-1');
    expect(sanitized).not.toContain('thread_123456789');
  });

  it('redacts local path assignments and bare absolute local paths', () => {
    const sanitized = sanitizeConnectedServiceDiagnosticString([
      'cwd=/Users/leeroy/Documents/Development/happier/dev',
      'candidatePersistedSessionFile="/tmp/native/pi-session-1.jsonl"',
      'workspace_root=C:\\Users\\leeroy\\repo',
      'visited /var/folders/private/state.json during recovery',
    ].join(' '));

    expect(sanitized).toContain(`cwd=${CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER}`);
    expect(sanitized).toContain(CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER);
    expect(sanitized).not.toContain('/Users/leeroy');
    expect(sanitized).not.toContain('/tmp/native');
    expect(sanitized).not.toContain('C:\\Users\\leeroy');
    expect(sanitized).not.toContain('/var/folders');
  });

  it('caps long diagnostic strings while allowing a narrower caller-owned cap', () => {
    expect(sanitizeConnectedServiceDiagnosticString('x'.repeat(650))).toHaveLength(500);
    expect(sanitizeConnectedServiceDiagnosticString('x'.repeat(650), { maxLength: 37 })).toHaveLength(37);
  });
});
