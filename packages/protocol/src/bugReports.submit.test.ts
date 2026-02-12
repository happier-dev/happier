import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  redactBugReportSensitiveText,
  submitBugReportToService,
  trimBugReportTextToMaxBytes,
  type BugReportFormPayload,
} from './bugReports.js';

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
    allowMaintainerFollowUp: true,
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
      labels: ['bug'],
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
      labels: ['bug'],
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
      labels: ['bug'],
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
      labels: ['bug'],
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
      labels: ['bug'],
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
      labels: ['bug'],
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
      'token=ghp_123456789012345678901234567890123456',
    ].join('\n');

    const output = redactBugReportSensitiveText(input);
    expect(output).toContain('authorization: bearer [REDACTED]');
    expect(output).toContain('cookie: [REDACTED]');
    expect(output).toContain('x-api-key: [REDACTED]');
    expect(output).not.toContain('ghp_1234567890');
    expect(output).not.toContain('eyJhbGciOiJI');
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

  it('does not crash when TextEncoder is unavailable', () => {
    const original = (globalThis as any).TextEncoder;
    vi.stubGlobal('TextEncoder', undefined as any);
    try {
      const input = `${'a'.repeat(5_000)}END-MARKER`;
      const trimmed = trimBugReportTextToMaxBytes(input, 2_048);
      expect(trimmed).toContain('END-MARKER');
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
      labels: ['bug'],
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
        labels: ['bug'],
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

  it('normalizes issue labels before sending submit payload', async () => {
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
      form: baseForm,
      artifacts: [],
      issueOwner: 'happier-dev',
      issueRepo: 'happier',
      labels: [' bug ', '', 'feature', 'bug', 'a'.repeat(100)],
      clientPrefix: 'test',
    });

    const submitBody = requestBodies.find((body) => typeof body.reportId === 'string' && 'uploadedArtifacts' in body) ?? {};
    const issue = (submitBody.issue ?? {}) as { labels?: unknown };
    expect(issue.labels).toEqual(['bug', 'feature', 'a'.repeat(40)]);
  });
});
