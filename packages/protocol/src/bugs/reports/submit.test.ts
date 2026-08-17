import { Buffer as NodeBuffer } from 'node:buffer';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  redactBugReportSensitiveText,
  submitBugReportToService,
  trimBugReportTextHeadToMaxBytes,
  trimBugReportTextToMaxBytes,
  type BugReportFormPayload,
} from './index.js';

type MockResponseInput = {
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
};

function mockResponse(input: MockResponseInput): Response {
  return {
    ok: input.ok,
    status: input.status,
    json: async () => input.json,
    text: async () => input.text ?? '',
  } as unknown as Response;
}

const baseForm: BugReportFormPayload = {
  title: 'Bug report',
  summary: 'summary',
  currentBehavior: 'current',
  expectedBehavior: 'expected',
  reproductionSteps: ['Open app'],
  frequency: 'often',
  severity: 'medium',
  environment: {
    appVersion: '1.0.0',
    platform: 'ios',
    deploymentType: 'cloud',
  },
  consent: {
    includeDiagnostics: true,
    acceptedPrivacyNotice: true,
  },
};

describe('submitBugReportToService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails fast with an explicit error when provider URL is invalid', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

      await expect(submitBugReportToService({
        providerUrl: 'not-a-valid-url',
        timeoutMs: 20_000,
        form: baseForm,
        artifacts: [],
        issueOwner: 'happier-dev',
        issueRepo: 'happier',
        clientPrefix: 'test',
      })).rejects.toThrow(/invalid bug report provider url/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails fast when issue owner is invalid', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

      await expect(submitBugReportToService({
        providerUrl: 'https://reports.happier.dev',
        timeoutMs: 20_000,
        form: baseForm,
        artifacts: [],
        issueOwner: 'owner/with/slash',
        issueRepo: 'happier',
        clientPrefix: 'test',
      })).rejects.toThrow(/invalid bug report issue target/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails fast when issue repo is invalid', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

      await expect(submitBugReportToService({
        providerUrl: 'https://reports.happier.dev',
        timeoutMs: 20_000,
        form: baseForm,
        artifacts: [],
        issueOwner: 'happier-dev',
        issueRepo: 'repo?bad=1',
        clientPrefix: 'test',
      })).rejects.toThrow(/invalid bug report issue target/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails fast when provider URL uses a non-http scheme', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

      await expect(submitBugReportToService({
        providerUrl: 'ftp://reports.happier.dev',
        timeoutMs: 20_000,
        form: baseForm,
        artifacts: [],
        issueOwner: 'happier-dev',
        issueRepo: 'happier',
        clientPrefix: 'test',
      })).rejects.toThrow(/invalid bug report provider url/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails when upload target count does not match artifact count', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/reports/session')) {
        return mockResponse({
          ok: true,
          status: 200,
          json: {
            reportId: 'report-1',
            uploadTargets: [
              {
                artifactId: 'artifact-1',
                objectKey: 'obj-1',
                uploadUrl: 'https://upload.example/obj-1',
                requiredHeaders: {},
              },
            ],
          },
        });
      }
      if (url.startsWith('https://upload.example/')) {
        return mockResponse({ ok: true, status: 200, text: '' });
      }
      if (url.endsWith('/v1/reports/submit')) {
        return mockResponse({
          ok: true,
          status: 200,
          json: {
            reportId: 'report-1',
            issueNumber: 1,
            issueUrl: 'https://github.com/happier-dev/happier/issues/1',
          },
        });
      }
      return mockResponse({ ok: false, status: 404, text: 'not-found' });
    });

    vi.stubGlobal('fetch', fetchMock);

      await expect(submitBugReportToService({
        providerUrl: 'https://reports.happier.dev',
        timeoutMs: 20_000,
        form: baseForm,
      artifacts: [
        {
          filename: 'a.log',
          sourceKind: 'cli',
          contentType: 'text/plain',
          content: 'a',
        },
        {
          filename: 'b.log',
          sourceKind: 'daemon',
          contentType: 'text/plain',
          content: 'b',
        },
        ],
        issueOwner: 'happier-dev',
        issueRepo: 'happier',
        clientPrefix: 'test',
      })).rejects.toThrow(/target count/i);
  });

  it('sanitizes environment serverUrl before sending session payload', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.body && typeof init.body === 'string') {
        requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      if (url.endsWith('/v1/reports/session')) {
        return mockResponse({
          ok: true,
          status: 200,
          json: {
            reportId: 'report-1',
            uploadTargets: [],
          },
        });
      }
      if (url.endsWith('/v1/reports/submit')) {
        return mockResponse({
          ok: true,
          status: 200,
          json: {
            reportId: 'report-1',
            issueNumber: 1,
            issueUrl: 'https://github.com/happier-dev/happier/issues/1',
          },
        });
      }
      return mockResponse({ ok: false, status: 404, text: 'not-found' });
    });

    vi.stubGlobal('fetch', fetchMock);

      await submitBugReportToService({
        providerUrl: 'https://reports.happier.dev',
        timeoutMs: 20_000,
      form: {
        ...baseForm,
        environment: {
          ...baseForm.environment,
          serverUrl: 'https://user:pass@example.dev/path?token=abc',
        },
        },
        artifacts: [],
        issueOwner: 'happier-dev',
        issueRepo: 'happier',
        clientPrefix: 'test',
      });

    const sessionBody = requestBodies[0] ?? {};
    const form = (sessionBody.form ?? {}) as Record<string, unknown>;
    const environment = (form.environment ?? {}) as Record<string, unknown>;
    expect(environment.serverUrl).toBe('https://example.dev/path');
  });

  it('redacts broad secret patterns from diagnostic text', () => {
    const input = [
      'authorization: bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
      'cookie: session=abc123',
      'x-api-key: sk-live-abc123def456ghi789',
      'profile=sk-doctor-config-profile-secret-123456',
      'token=ghp_123456789012345678901234567890123456',
      '"access_token": "provider-access-token"',
      '"refresh_token": "provider-refresh-token"',
    ].join('\n');

    const output = redactBugReportSensitiveText(input);
    expect(output).toContain('authorization: bearer [REDACTED]');
    expect(output).toContain('cookie: [REDACTED]');
    expect(output).toContain('x-api-key: [REDACTED]');
    expect(output).not.toContain('ghp_1234567890');
    expect(output).not.toContain('sk-doctor-config-profile-secret-123456');
    expect(output).not.toContain('eyJhbGciOiJI');
    expect(output).not.toContain('provider-access-token');
    expect(output).not.toContain('provider-refresh-token');
  });

  it('fully redacts bearer tokens that include URL-safe and base64 characters', () => {
    const output = redactBugReportSensitiveText('Authorization: Bearer abc/def+ghi==');
    expect(output).toContain('authorization: bearer [REDACTED]');
    expect(output).not.toContain('/def+ghi==');
  });

  it('trims oversized artifacts close to the configured byte budget', () => {
    const input = `${'a'.repeat(20_000)}END-MARKER`;
    const trimmed = trimBugReportTextToMaxBytes(input, 2_048);
    const byteLength = Buffer.byteLength(trimmed, 'utf8');

    expect(byteLength).toBeLessThanOrEqual(2_048);
    expect(byteLength).toBeGreaterThan(1_800);
    expect(trimmed).toContain('END-MARKER');
  });

  it('keeps the leading text of a head-bounded cause without splitting a character', () => {
    // A thrown message opens by naming the failure, so the head bound keeps the
    // opening — and the cut lands on a character boundary rather than inside the
    // 4-byte emoji that straddles the budget.
    const head = `START-MARKER${'a'.repeat(2_048 - 'START-MARKER'.length - 2)}`;
    const trimmed = trimBugReportTextHeadToMaxBytes(`${head}\u{1F600}END-MARKER`, 2_048);

    expect(trimmed).toBe(head);
    expect(trimmed).not.toContain('�');
    expect(Buffer.byteLength(trimmed, 'utf8')).toBe(2_046);
  });

  it('never ends a head-bounded cause on half of a surrogate pair', () => {
    // The budget leaves room for the 3 bytes a lone lead surrogate encodes to but
    // not the 4 the whole emoji needs, so only the pair-aware bound stays clean.
    const head = 'a'.repeat(2_046);
    const trimmed = trimBugReportTextHeadToMaxBytes(`${head}\u{1F600}`, 2_049);

    expect(trimmed).toBe(head);
    expect(trimmed).not.toContain('�');
  });

  it('does not crash when TextEncoder is unavailable', () => {
    const original = (globalThis as any).TextEncoder;
    vi.stubGlobal('TextEncoder', undefined as any);
    try {
      const input = `${'🙂'.repeat(1_200)}END-MARKER`;
      const trimmed = trimBugReportTextToMaxBytes(input, 2_048);
      expect(trimmed).toContain('END-MARKER');
      expect(Buffer.byteLength(trimmed, 'utf8')).toBeLessThanOrEqual(2_048);
      expect(trimmed).not.toContain('�');
    } finally {
      vi.stubGlobal('TextEncoder', original);
    }
  });

  it('keeps head- and tail-bound cuts within bytes and on character boundaries without platform UTF-8 helpers', () => {
    const originalTextEncoder = (globalThis as any).TextEncoder;
    const originalBuffer = (globalThis as any).Buffer;
    vi.stubGlobal('TextEncoder', undefined as any);
    vi.stubGlobal('Buffer', undefined as any);
    try {
      const tail = trimBugReportTextToMaxBytes(`${'🙂'.repeat(1_000)}A`, 1_024);
      const head = trimBugReportTextHeadToMaxBytes('🙂'.repeat(1_000), 1_024);
      const firstCodeUnit = tail.charCodeAt(0);

      expect(firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff).toBe(false);
      expect(NodeBuffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(1_024);
      expect(NodeBuffer.byteLength(head, 'utf8')).toBeLessThanOrEqual(1_024);
      expect(NodeBuffer.from(tail, 'utf8').toString('utf8')).not.toContain('�');
      expect(NodeBuffer.from(head, 'utf8').toString('utf8')).not.toContain('�');
    } finally {
      vi.stubGlobal('TextEncoder', originalTextEncoder);
      vi.stubGlobal('Buffer', originalBuffer);
    }
  });

  it('enforces the head byte ceiling for multibyte text when TextEncoder is unavailable', () => {
    const original = (globalThis as any).TextEncoder;
    vi.stubGlobal('TextEncoder', undefined as any);
    try {
      const trimmed = trimBugReportTextHeadToMaxBytes('🙂'.repeat(1_200), 2_048);

      expect(Buffer.byteLength(trimmed, 'utf8')).toBeLessThanOrEqual(2_048);
      expect(trimmed).not.toContain('�');
    } finally {
      vi.stubGlobal('TextEncoder', original);
    }
  });

  it('redacts and bounds artifact content before upload as defense in depth', async () => {
    const uploadBodies: string[] = [];
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/reports/session')) {
        return mockResponse({
          ok: true,
          status: 200,
          json: {
            reportId: 'report-1',
            uploadTargets: [
              {
                artifactId: 'artifact-1',
                objectKey: 'obj-1',
                uploadUrl: 'https://upload.example/obj-1',
                requiredHeaders: {},
              },
            ],
          },
        });
      }
      if (url.startsWith('https://upload.example/')) {
        uploadBodies.push(String(init?.body ?? ''));
        return mockResponse({ ok: true, status: 200, text: '' });
      }
      if (url.endsWith('/v1/reports/submit')) {
        return mockResponse({
          ok: true,
          status: 200,
          json: {
            reportId: 'report-1',
            issueNumber: 1,
            issueUrl: 'https://github.com/happier-dev/happier/issues/1',
          },
        });
      }
      return mockResponse({ ok: false, status: 404, text: 'not-found' });
    });

    vi.stubGlobal('fetch', fetchMock);

      await submitBugReportToService({
        providerUrl: 'https://reports.happier.dev',
        timeoutMs: 20_000,
      form: baseForm,
      maxArtifactBytes: 2_048,
      artifacts: [
        {
          filename: 'cli.log',
          sourceKind: 'cli',
          contentType: 'text/plain',
          content: `${'a'.repeat(5000)}\nauthorization: bearer ghp_123456789012345678901234567890`,
        },
        ],
        issueOwner: 'happier-dev',
        issueRepo: 'happier',
        clientPrefix: 'test',
      });

    expect(uploadBodies).toHaveLength(1);
    expect(uploadBodies[0]).toContain('authorization: bearer [REDACTED]');
    expect(uploadBodies[0]).not.toContain('ghp_1234567890');
    expect(uploadBodies[0].length).toBeLessThanOrEqual(2_048);
  });

  it('redacts and bounds provider error body before surfacing in thrown error', async () => {
    const secret = 'authorization: bearer ghp_123456789012345678901234567890123456';
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/reports/session')) {
        return mockResponse({
          ok: false,
          status: 500,
          text: `${'x'.repeat(8_000)}\n${secret}\n${'y'.repeat(8_000)}`,
        });
      }
      return mockResponse({ ok: false, status: 404, text: 'not-found' });
    });

    vi.stubGlobal('fetch', fetchMock);

    let thrown: unknown = null;
    try {
        await submitBugReportToService({
          providerUrl: 'https://reports.happier.dev',
          timeoutMs: 20_000,
          form: baseForm,
          artifacts: [],
          issueOwner: 'happier-dev',
          issueRepo: 'happier',
          clientPrefix: 'test',
        });
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown ?? '');
    expect(message).toContain('Request failed (500):');
    expect(message).not.toContain('ghp_12345678901234567890');
    expect(message).not.toContain('authorization: bearer ghp_');
    expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(1_300);
  });

    it('includes selected existing issue number in submit payload', async () => {
      const requestBodies: Array<Record<string, unknown>> = [];
      const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.body && typeof init.body === 'string') {
        requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      if (url.endsWith('/v1/reports/session')) {
        return mockResponse({
          ok: true,
          status: 200,
          json: {
            reportId: 'report-1',
            uploadTargets: [],
          },
        });
      }
      if (url.endsWith('/v1/reports/submit')) {
        return mockResponse({
          ok: true,
          status: 200,
          json: {
            reportId: 'report-1',
            issueNumber: 99,
            issueUrl: 'https://github.com/happier-dev/happier/issues/99',
          },
        });
      }
      return mockResponse({ ok: false, status: 404, text: 'not-found' });
    });

    vi.stubGlobal('fetch', fetchMock);

      await submitBugReportToService({
        providerUrl: 'https://reports.happier.dev',
        timeoutMs: 20_000,
        form: baseForm,
        artifacts: [],
        issueOwner: 'happier-dev',
        issueRepo: 'happier',
        clientPrefix: 'test',
        existingIssueNumber: 99,
      });

      const submitBody = requestBodies.find((body) => typeof body.reportId === 'string' && 'uploadedArtifacts' in body) ?? {};
      const issue = (submitBody.issue ?? {}) as { number?: unknown; labels?: unknown };
      expect(issue.number).toBe(99);
      expect(issue.labels).toBeUndefined();
    });
});
