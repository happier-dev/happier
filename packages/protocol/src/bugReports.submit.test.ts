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
      'token=ghp_123456789012345678901234567890123456',
      '"access_token": "provider-access-token"',
      '"refresh_token": "provider-refresh-token"',
    ].join('\n');

    const output = redactBugReportSensitiveText(input);
    // Absence of the credential is the check; the marker is only corroboration. A rule that emits
    // the marker beside a live secret satisfies a `toContain` assertion while leaking.
    expect(output).not.toContain('session=abc123');
    expect(output).not.toContain('sk-live-abc123def456ghi789');
    expect(output).toContain('authorization: bearer [REDACTED]');
    expect(output).toContain('cookie: [REDACTED]');
    expect(output).toContain('x-api-key: [REDACTED]');
    expect(output).not.toContain('ghp_1234567890');
    expect(output).not.toContain('eyJhbGciOiJI');
    expect(output).not.toContain('provider-access-token');
    expect(output).not.toContain('provider-refresh-token');
  });

  it('fully redacts bearer tokens that include URL-safe and base64 characters', () => {
    const output = redactBugReportSensitiveText('Authorization: Bearer abc/def+ghi==');
    expect(output).toContain('authorization: bearer [REDACTED]');
    expect(output).not.toContain('/def+ghi==');
  });

  it('redacts an authorization header whose scheme is not bearer', () => {
    // `Authorization: <opaque>` and `Authorization: Basic <base64>` are as sensitive as a bearer
    // token; only the bearer spelling was covered.
    expect(redactBugReportSensitiveText('Authorization: abcDEF123ghiJKL456')).not.toContain('abcDEF123ghiJKL456');
    expect(redactBugReportSensitiveText('authorization: Basic dXNlcjpwYXNzd29yZA==')).not.toContain('dXNlcjpwYXNzd29yZA==');
  });

  it('redacts provider keys whose body contains separators', () => {
    // `sk-ant-api03-…` and `sk-proj_…` are the shipped Anthropic/OpenAI shapes; a body pattern of
    // `[A-Za-z0-9]` alone stops at the first `-` and leaves the whole key in the text.
    const output = redactBugReportSensitiveText('key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH done');
    expect(output).not.toContain('sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');
    expect(output).toContain('done');
  });

  it('redacts a credential passed as a separate flag argument, not only as flag=value', () => {
    // `--token=x` was covered; `--token x` is the same secret in the shape a shell actually uses.
    expect(redactBugReportSensitiveText('curl --token abc123def456 https://x.test'))
      .toBe('curl --token [REDACTED] https://x.test');
    expect(redactBugReportSensitiveText('deploy --api-key abc123 --verbose'))
      .toBe('deploy --api-key [REDACTED] --verbose');
    // A flag whose value is another flag has no value to redact.
    expect(redactBugReportSensitiveText('deploy --token --verbose')).toBe('deploy --token --verbose');
    // Ordinary flags keep their arguments.
    expect(redactBugReportSensitiveText('sort --key 2 file.txt')).toBe('sort --key 2 file.txt');
  });

  it('leaves an authorization value that is already redacted alone', () => {
    expect(redactBugReportSensitiveText('Authorization: Bearer abc123def456ghi789'))
      .toBe('authorization: bearer [REDACTED]');
  });

  it('redacts a quoted authorization value rather than printing a marker beside the live credential', () => {
    // A `[REDACTED]` marker emitted next to an intact credential is worse than no rule at all:
    // every grep, audit and live gate that looks for the marker then passes on a leak. The value
    // class must not be satisfiable by the whitespace that sits before the opening quote.
    const quoted = [
      'Authorization: "Bearer opaque-value-here-1234"',
      "Authorization: 'Bearer opaque-value-here-1234'",
      'curl -H "Authorization: Bearer opaque-value-here-1234" https://x.test',
      'Authorization: Bearer "opaque-value-here-1234"',
      'Authorization: "opaque-value-here-1234"',
    ];
    for (const input of quoted) {
      expect(redactBugReportSensitiveText(input), input).not.toContain('opaque-value-here-1234');
    }

    const basic = ['authorization:  "Basic YWRtaW46aHVudGVyMg=="', "authorization: 'Basic YWRtaW46aHVudGVyMg=='"];
    for (const input of basic) {
      expect(redactBugReportSensitiveText(input), input).not.toContain('YWRtaW46aHVudGVyMg==');
    }
  });

  it('does not claim to have redacted an authorization header that carries no value', () => {
    // The same whitespace-only match, seen from the other side: a marker on an empty header is a
    // false positive that trains readers to trust the marker.
    expect(redactBugReportSensitiveText('Authorization:')).toBe('Authorization:');
    expect(redactBugReportSensitiveText('Authorization:   ')).toBe('Authorization:   ');
    expect(redactBugReportSensitiveText('Authorization: ""')).toBe('Authorization: ""');
  });

  it('redacts credentials embedded in a URL authority', () => {
    // `git clone https://<user>:<token>@…` is the likeliest credential shape in a real command
    // line, and none of the header or assignment rules can see it.
    const leaks: ReadonlyArray<readonly [string, string]> = [
      ['git clone https://user:ghp_SHORTBUTREALTOKEN@github.com/o/r.git', 'ghp_SHORTBUTREALTOKEN'],
      ['pg_dump postgres://svc:S3cr3tPass@10.0.0.5:5432/app', 'S3cr3tPass'],
      ['redis-cli -u redis://default:MyR3d1sPass@cache:6379 ping', 'MyR3d1sPass'],
      ['curl http://admin:hunter2@internal.example.test/deploy', 'hunter2'],
    ];
    for (const [input, secret] of leaks) {
      expect(redactBugReportSensitiveText(input), input).not.toContain(secret);
    }
    // The host is the diagnostic value of the line; only the userinfo goes.
    expect(redactBugReportSensitiveText('git clone https://user:ghp_SHORTBUTREALTOKEN@github.com/o/r.git'))
      .toBe('git clone https://[REDACTED]@github.com/o/r.git');
    // No userinfo, nothing to redact — a port must not be mistaken for a password separator.
    expect(redactBugReportSensitiveText('curl https://example.test:8443/v1/things'))
      .toBe('curl https://example.test:8443/v1/things');
    expect(redactBugReportSensitiveText('git clone ssh://git@github.com/o/r.git'))
      .toBe('git clone ssh://git@github.com/o/r.git');
  });

  it('consumes a quoted credential to its closing quote instead of stopping at the first space', () => {
    // The same defect class as the quoted authorization header, in the assignment and flag rules: a
    // value pattern of `\S+` ends at the space inside a quoted passphrase, so `[REDACTED]` lands
    // after the first word and the rest of the credential survives immediately beside it.
    const remainders: ReadonlyArray<readonly [string, string]> = [
      ['deploy --password "correct horse battery staple"', 'horse battery staple'],
      ["deploy --token 'abc def secretvalue'", 'def secretvalue'],
      ['access_token = "abc def secretvalue"', 'def secretvalue'],
      ['secret = "a b c secretvalue"', 'b c secretvalue'],
      ['password: "hunter two secret"', 'two secret'],
    ];
    for (const [input, remainder] of remainders) {
      expect(redactBugReportSensitiveText(input), input).not.toContain(remainder);
    }
    // An unquoted value still ends at the first space — the rest of the line is not a credential.
    expect(redactBugReportSensitiveText('deploy --token abc123 --verbose'))
      .toBe('deploy --token [REDACTED] --verbose');
  });

  it('redacts an authorization credential carried as a JSON field', () => {
    // Serialized request headers are a real artifact shape here (`serializeAxiosErrorForLog`), and
    // `"Authorization": "Bearer …"` never reaches the header rules: the quote between the key and
    // the colon means `authorization\s*:` cannot match.
    const output = redactBugReportSensitiveText('{"Authorization":"Bearer sk-ant-FAKEFAKEFAKE"}');
    expect(output).not.toContain('sk-ant-FAKEFAKEFAKE');
  });

  it('redacts a bearer value that a quote splits rather than stopping at the quote', () => {
    // The regression this file's own quoted-header fix introduced: narrowing the value class to
    // `[^"'\r\n]+` made a quote a terminator, so a header value that merely CONTAINS one printed
    // the marker and kept the rest. In a log line an authorization value runs to the newline; the
    // quote only terminates it when it is the value's own or the enclosing argument's.
    expect(redactBugReportSensitiveText('Authorization: Bearer abc "quoted-tail-secret-xyz"'))
      .toBe('authorization: bearer [REDACTED]');
    expect(redactBugReportSensitiveText('Authorization: Bearer abc"gluedtailsecret'))
      .toBe('authorization: bearer [REDACTED]');
    // …and the enclosing argument's quote still terminates it, so the URL survives.
    expect(redactBugReportSensitiveText('curl -H "Authorization: Bearer tok123456" https://x.test'))
      .toBe('curl -H "authorization: bearer [REDACTED]" https://x.test');
  });

  it('follows a folded header onto its continuation line, but not onto an unindented one', () => {
    // Log serializers wrap long headers, and the rules used to reach the continuation only because
    // they spelled the gap as `\s*`. `\s*` is too much, though: it also swallows an UNindented next
    // line, so `Authorization:` at the end of a paragraph redacted the sentence after it.
    expect(redactBugReportSensitiveText('authorization:\n  Bearer opaquetok12345'))
      .toBe('authorization: bearer [REDACTED]');
    expect(redactBugReportSensitiveText('cookie:\n  sessionid=abc123secret')).toBe('cookie: [REDACTED]');
    expect(redactBugReportSensitiveText('password:\n\thunter2correcthorse')).toBe('password: [REDACTED]');
    expect(redactBugReportSensitiveText('Authorization:\nkeep-this-benign-line'))
      .toBe('Authorization:\nkeep-this-benign-line');
  });

  it('redacts a credential key whose name is joined by underscores', () => {
    // `\b` cannot match inside `AWS_SECRET_ACCESS_KEY` — an underscore is a word character — so the
    // top-five real-world credential export was invisible to every rule here. The key name is
    // matched by the credential word it contains, not by an exact spelling.
    const leaks: ReadonlyArray<readonly [string, string]> = [
      ['export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
      ['aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
      ['export GITHUB_TOKEN=opaque-ci-token-value-123', 'opaque-ci-token-value-123'],
      ['docker run -e DATABASE_PASSWORD=hunter2correct myimage', 'hunter2correct'],
    ];
    for (const [input, secret] of leaks) {
      expect(redactBugReportSensitiveText(input), input).not.toContain(secret);
    }
    // A compound key with a counted value is not a credential, and this codebase logs those
    // constantly; blanking them would trade a real diagnostic for no security.
    expect(redactBugReportSensitiveText('max_tokens=1000 input_tokens: 512')).toBe('max_tokens=1000 input_tokens: 512');
    expect(redactBugReportSensitiveText('the access_token expired')).toBe('the access_token expired');
    // A key name is short. An unbroken run long enough to be a payload is a payload even when the
    // letters `token` appear inside it, so it is not read as a key — which is also what keeps the
    // key-name expansion linear over the long opaque runs a bug report is full of.
    const payloadContainingTheWord = `QUJDREVG${'A'.repeat(60)}token${'B'.repeat(60)}`;
    expect(redactBugReportSensitiveText(`${payloadContainingTheWord}=1`)).toBe(`${payloadContainingTheWord}=1`);
  });

  it('redacts a token carried as a URL username with no password', () => {
    // GitHub documents exactly this for git-over-https with a fine-grained PAT, and the rule that
    // requires a `:` inside the userinfo cannot see it.
    const leaks: ReadonlyArray<readonly [string, string]> = [
      [
        'git clone https://github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklm@github.com/o/r.git',
        'github_pat_11ABCDEFG0',
      ],
      ['git clone https://glpat-1a2b3c4d5e6f7g8h9i0j@gitlab.com/o/r.git', 'glpat-1a2b3c4d5e6f7g8h9i0j'],
      ['git fetch https://glob-deploy-tok-9f2a41b7c3d5@git.example.com/o/r.git', 'glob-deploy-tok-9f2a41b7c3d5'],
    ];
    for (const [input, secret] of leaks) {
      expect(redactBugReportSensitiveText(input), input).not.toContain(secret);
    }
    // An ordinary username is not a credential, and blanking it would cost the line its meaning.
    expect(redactBugReportSensitiveText('git clone ssh://git@github.com/o/r.git'))
      .toBe('git clone ssh://git@github.com/o/r.git');
    expect(redactBugReportSensitiveText('git clone https://alice@github.com/o/r.git'))
      .toBe('git clone https://alice@github.com/o/r.git');
  });

  it('redacts the token shapes the named-prefix rules could not spell', () => {
    // `gh[pousr]_` cannot match `github_pat_`: `gh` is followed by `i`, and the body carries `_`.
    // `glpat-`/`xox…-` had no rule at all, and `A3T[A-Z0-9]{16}` is 19 characters, so it could only
    // ever match a string that no real 20-character AWS key id has.
    const leaks: ReadonlyArray<readonly [string, string]> = [
      [
        'echo github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklm',
        'github_pat_11ABCDEFG0',
      ],
      ['echo glpat-1a2b3c4d5e6f7g8h9i0j', 'glpat-1a2b3c4d5e6f7g8h9i0j'],
      ['echo xoxb-1234567890-0987654321-AbCdEfGhIjKlMnOpQrStUvWx', 'xoxb-1234567890'],
      ['export AWS_ACCESS_KEY_ID=A3TXBGHXYZ123456ABCD', 'A3TXBGHXYZ123456ABCD'],
    ];
    for (const [input, secret] of leaks) {
      expect(redactBugReportSensitiveText(input), input).not.toContain(secret);
    }
  });

  it('redacts a PowerShell header hashtable, which separates key from value with `=`', () => {
    // Windows is first-class here and PowerShell is its native shell; the authorization rules
    // required a `:` that this syntax never writes.
    expect(redactBugReportSensitiveText('Invoke-WebRequest -Headers @{Authorization="Bearer opaquetok12345"}'))
      .not.toContain('opaquetok12345');
  });

  it('carries a quoted credential across an embedded newline instead of stopping at it', () => {
    // A quoted value that contains a newline is still one value. Cutting it at the newline emits
    // the marker and leaves the second half in the text — the same false-marker class in miniature.
    const leaks: ReadonlyArray<readonly [string, string]> = [
      ['deploy --password "firstzVq7Ky3TmXw9half\nsecondXhalfQm4Rt8Lp"', 'Qm4Rt8Lp'],
      ['token: "aaazVq7Ky3TmXw9\nbbbQm4Rt8LpTAIL"', 'Qm4Rt8Lp'],
      ['Authorization: Bearer "aaazVq7Ky3TmXw9\nbbbQm4Rt8LpTAIL"', 'Qm4Rt8Lp'],
    ];
    for (const [input, secret] of leaks) {
      expect(redactBugReportSensitiveText(input), input).not.toContain(secret);
    }
    // An opening quote with no closing quote anywhere is a truncated log, not a multi-line value:
    // it stops at end of line rather than eating the rest of the report.
    expect(redactBugReportSensitiveText('deploy --password "truncated\nkeep-this-diagnostic-line'))
      .toBe('deploy --password [REDACTED]\nkeep-this-diagnostic-line');
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
