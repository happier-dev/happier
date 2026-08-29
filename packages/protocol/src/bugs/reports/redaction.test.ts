import { describe, expect, it } from 'vitest';

import {
  createSensitiveDiagnosticTextRedactor,
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

  it('supports isolated exact-value leases without changing process-global support redaction', () => {
    const value = 'q';
    const isolated = createSensitiveDiagnosticTextRedactor();
    const lease = isolated.register([value]);
    try {
      expect(isolated.redact(`value=${value}`)).toBe('value=[REDACTED]');
      expect(redactBugReportSensitiveText(`ordinary ${value} value`)).toBe(`ordinary ${value} value`);
    } finally {
      lease.close();
    }
    expect(isolated.redact(`value=${value}`)).toBe(`value=${value}`);
  });
});

describe('constructible credential shapes in diagnostic text', () => {
  it('redacts npm registry auth tokens by prefix and by npmrc assignment', () => {
    const token = 'npm_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

    expect(redactBugReportSensitiveText(`//registry.npmjs.org/:_authToken=${token}`))
      .toBe('//registry.npmjs.org/:_authToken=[REDACTED]');
    expect(redactBugReportSensitiveText(`npm ERR! using ${token} failed`))
      .toBe('npm ERR! using [REDACTED] failed');
  });

  it('redacts credentials embedded in a URL userinfo component but keeps the host', () => {
    expect(redactBugReportSensitiveText(
      'clone failed: https://oauth2:glpat-ABCDEFGHIJKLMNOPQRST@gitlab.com/acme/plugin.git',
    )).toBe('clone failed: https://[REDACTED]@gitlab.com/acme/plugin.git');
    expect(redactBugReportSensitiveText('registry ssh://git:hunter2@example.com:2222/repo'))
      .toBe('registry ssh://[REDACTED]@example.com:2222/repo');
  });

  it('redacts credential query values in diagnostic URLs while retaining safe context', () => {
    const redacted = redactBugReportSensitiveText(
      'fetch https://alice:query-userinfo@example.test/v1?access_token=query-secret&safe=yes failed',
    );

    expect(redacted).not.toContain('alice');
    expect(redacted).not.toContain('query-userinfo');
    expect(redacted).not.toContain('query-secret');
    expect(redacted).toContain('example.test');
    expect(redacted).toContain('safe=yes');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts every segment-aware base credential label in unquoted diagnostic assignments', () => {
    const input = [
      'authorization=Bearer authorization-secret',
      'accessToken=access-token-secret',
      'refresh_token=refresh-token-secret',
      'api-key=api-key-secret',
      'clientSecret=client-secret',
      'password=password-secret',
      'cookie=cookie-secret',
      'jwt=jwt-secret',
      'private_key=private-key-secret',
      'passphrase=passphrase-secret',
      'x-user-id=user-secret',
      'chatgpt-account-id=account-secret',
      'sessionCount=7',
      'tokenCount=8',
      'secretary=meeting-notes',
    ].join(' ');

    const redacted = redactBugReportSensitiveText(input);

    for (const secret of [
      'authorization-secret',
      'access-token-secret',
      'refresh-token-secret',
      'api-key-secret',
      'client-secret',
      'password-secret',
      'cookie-secret',
      'jwt-secret',
      'private-key-secret',
      'passphrase-secret',
      'user-secret',
      'account-secret',
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('sessionCount=7');
    expect(redacted).toContain('tokenCount=8');
    expect(redacted).toContain('secretary=meeting-notes');
  });

  it('redacts complete and unterminated quoted values after an unquoted credential label', () => {
    const complete = redactBugReportSensitiveText(
      'client_secret="first word complete-tail" sessionCount="still visible"',
    );
    expect(complete).not.toContain('first word');
    expect(complete).not.toContain('complete-tail');
    expect(complete).toContain('sessionCount="still visible"');

    const unterminated = redactBugReportSensitiveText(
      'refresh_token="first word unterminated-tail\ncontinued credential material',
    );
    expect(unterminated).not.toContain('first word');
    expect(unterminated).not.toContain('unterminated-tail');
    expect(unterminated).not.toContain('continued credential material');
    expect(unterminated).toContain('[REDACTED]');
  });

  it('redacts an AWS access key id and its paired secret access key', () => {
    expect(redactBugReportSensitiveText(
      'aws_access_key_id=AKIAIOSFODNN7EXAMPLE aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    )).toBe('aws_access_key_id=[REDACTED] aws_secret_access_key: [REDACTED]');
  });

  it('leaves ordinary non-secret diagnostic text untouched', () => {
    const text = [
      'ENOENT: no such file or directory, open /Users/alice/projects/acme/.happier-plugin/plugin.json',
      'expected sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
      'see https://github.com/acme/plugin/releases/tag/v1.2.3 for details',
      'npm install failed for @acme/plugin-runtime@1.2.3',
    ].join('\n');

    expect(redactBugReportSensitiveText(text)).toBe(text);
  });

  it('stays bounded on large inputs that repeat a credential-shaped prefix', () => {
    const input = `${'https://user@host/path '.repeat(20_000)}npm_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6`;
    const startedAt = Date.now();
    const redacted = redactBugReportSensitiveText(input);

    expect(redacted).not.toContain('npm_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6');
    expect(redacted).not.toContain('https://user@host');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('stays bounded on a long delimiter-free run that never completes a scheme', () => {
    // Every offset is a candidate scheme start; only a bounded scheme prefix
    // keeps the URL-credential pattern from rescanning the whole run each time.
    const startedAt = Date.now();

    expect(redactBugReportSensitiveText('a.b-c1+'.repeat(60_000))).toBe('a.b-c1+'.repeat(60_000));
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe('compile failures keep the names they have to state', () => {
  // A bare AWS secret access key is 40 base64 characters carrying both cases and
  // a digit, and nothing else. This repository's `…V1`/`…Schema` convention emits
  // that exact shape by the hundred, so judging text by it destroyed 216 distinct
  // real first-party identifiers across 1,350 tracked source lines. These are
  // measured samples of that damage, and they are the reason no rule here may
  // redact a value on unlabelled length-and-alphabet evidence alone.
  const identifiers = [
    'SessionTranscriptObservationProvenanceV1',
    'ConnectedServiceCredentialRecordV1Schema',
  ];

  it('keeps a 40-character first-party identifier in the diagnostics that name it', () => {
    for (const identifier of identifiers) {
      expect(identifier).toHaveLength(40);
      expect(redactBugReportSensitiveText(identifier)).toBe(identifier);

      for (const diagnostic of [
        `error TS2322: Type 'string' is not assignable to type '${identifier}'.`,
        `error TS2305: Module '@happier-dev/protocol' has no exported member '${identifier}'.`,
        `    at ${identifier} (/Users/alice/dev/packages/protocol/src/bugs/reports/redaction.ts:12:9)`,
      ]) {
        expect(redactBugReportSensitiveText(diagnostic)).toBe(diagnostic);
      }
    }
  });

  it('keeps the absolute and repository-relative paths a failure reports', () => {
    for (const path of [
      // The plugin dev loop reports its sandbox source root by absolute path.
      '/var/folders/T/happierPluginDev1/Sources',
      'apps/cli/src/utils/crypto/aes256GcmBytes.test.ts',
      'packages/tests/src/testkit/uiE2e/cliJson.spec.ts',
      '/Users/alice/dev/packages/plugin-sdk/src/experimental/uiHostedWebBridgeV1.ts',
    ]) {
      expect(redactBugReportSensitiveText(path)).toBe(path);
      expect(redactBugReportSensitiveText(`error TS2307 in ${path}: cannot find module`))
        .toBe(`error TS2307 in ${path}: cannot find module`);
    }
  });

  it('reports a label-free AWS secret access key verbatim, and a labelled one never', () => {
    // The honest cost of the rule above: an unlabelled key has no shape this
    // redactor may act on. Every form that names itself is still removed.
    const key = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

    expect(redactBugReportSensitiveText(`credential ${key} rejected`)).toBe(`credential ${key} rejected`);
    expect(redactBugReportSensitiveText(`aws_secret_access_key=${key}`)).toBe('aws_secret_access_key: [REDACTED]');
    expect(redactBugReportSensitiveText(`AWS_SECRET_ACCESS_KEY: ${key}`)).toBe('AWS_SECRET_ACCESS_KEY: [REDACTED]');
    expect(redactBugReportSensitiveText(`{"secret":"${key}"}`)).toBe('{"secret": "[REDACTED]"}');
  });
});

describe('JSON Web Tokens in diagnostic text', () => {
  const jwt = [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ',
    'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  ].join('.');

  it('redacts a token at every delimiter its segments allow', () => {
    expect(redactBugReportSensitiveText(`authorization header carried ${jwt} and failed`))
      .toBe('authorization header carried [REDACTED] and failed');
    // A hyphen and a dot are both segment characters and both token delimiters,
    // so a token glued to either still has to go.
    expect(redactBugReportSensitiveText(`x-happier-auth-${jwt}`)).toBe('x-happier-auth-[REDACTED]');
    expect(redactBugReportSensitiveText(`payload.${jwt}`)).toBe('payload.[REDACTED]');
    expect(redactBugReportSensitiveText(`${jwt}-`)).toBe('[REDACTED]');
    expect(redactBugReportSensitiveText(`{"idToken":"${jwt}"}`)).toBe('{"idToken": "[REDACTED]"}');
  });

  it('leaves base64url text that is not a three-segment token intact', () => {
    for (const text of [
      'eyJhbGciOiJIUzI1NiJ9.short.tooshort',
      'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC',
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
    ]) {
      expect(redactBugReportSensitiveText(text)).toBe(text);
    }
  });

  it('stays linear on a long run that opens a token at every hyphen', () => {
    // `-` ends a word without ending a base64url run, so the single-pattern form
    // re-scanned the whole remainder from each `-eyJ` and cost seconds on a few
    // hundred kilobytes of ordinary agent output. Doubling the input must roughly
    // double the work, not quadruple it.
    const input = `${'-eyJ'}${'A'.repeat(40)}`.repeat(8_000);
    expect(input.length).toBeGreaterThan(350_000);

    const startedAt = Date.now();
    expect(redactBugReportSensitiveText(input)).toBe(input);

    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('stays linear on a long run whose token candidates all fail late', () => {
    const input = `${'-eyJ'}${'A'.repeat(5)}.`.repeat(48_000);
    const startedAt = Date.now();

    expect(redactBugReportSensitiveText(input)).toBe(input);

    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});

describe('redaction stays linear on adversarial diagnostic text', () => {
  it('completes a quoted secret field that never terminates in bounded time', () => {
    // Arbitrary plugin compile-failure text reaches this redactor, so a source
    // fragment that opens a quoted secret value and then piles up escapes must
    // not make the value scan explore an exponential number of parses.
    const adversarial = `{"password":"${'\\'.repeat(40)}`;
    const startedAt = Date.now();
    const redacted = redactBugReportSensitiveText(adversarial);
    const elapsedMs = Date.now() - startedAt;

    expect(redacted).toContain('password');
    expect(elapsedMs).toBeLessThan(500);
  });

  it('completes a very long unterminated quoted value in bounded time', () => {
    const adversarial = `{"api_key":"${'a'.repeat(200_000)}`;
    const startedAt = Date.now();

    redactBugReportSensitiveText(adversarial);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('still redacts a terminated quoted secret field and leaves its key visible', () => {
    expect(redactBugReportSensitiveText('{"password":"hunter2","port":5432}'))
      .toBe('{"password": "[REDACTED]","port":5432}');
    expect(redactBugReportSensitiveText('{"client_secret":"a\\"b\\\\c"}'))
      .toBe('{"client_secret": "[REDACTED]"}');
  });

  it('redacts a quoted secret value of any length, not only a bounded prefix of one', () => {
    // A repetition bound on the value scan turns every longer secret into a
    // verbatim leak, which is a worse outcome than the scan cost it avoids.
    for (const length of [4_096, 4_097, 8_000, 64_000]) {
      const secret = `A${'B'.repeat(length - 1)}`;
      const redacted = redactBugReportSensitiveText(`{"client_secret":"${secret}"}`);

      expect(redacted).not.toContain(secret);
      expect(redacted).toBe('{"client_secret": "[REDACTED]"}');
    }
  });

  it('completes repeated private-key start markers that never terminate in bounded time', () => {
    // Arbitrary plugin text can open a private-key block thousands of times and
    // never close one; no start may pay a rescan of the remaining input.
    const adversarial = '-----BEGIN A PRIVATE KEY-----'.repeat(36_000);
    const startedAt = Date.now();
    const redacted = redactBugReportSensitiveText(adversarial);
    const elapsedMs = Date.now() - startedAt;

    expect(redacted).toContain('-----BEGIN A PRIVATE KEY-----');
    expect(elapsedMs).toBeLessThan(500);
  });
});

describe('additional constructible credential shapes', () => {
  it('redacts every userinfo character when the password itself contains an at sign', () => {
    expect(redactBugReportSensitiveText('https://alice:s3cr3tP@ss@github.com/o/r'))
      .toBe('https://[REDACTED]@github.com/o/r');
    expect(redactBugReportSensitiveText('fetch https://example.com/issues?assignee=bob@acme.com failed'))
      .toBe('fetch https://example.com/issues?assignee=bob@acme.com failed');
  });

  it('redacts legacy npmrc auth assignments whose values carry no recognizable prefix', () => {
    expect(redactBugReportSensitiveText('//registry.npmjs.org/:_authToken=3f2504e0-4f89-11d3-9a0c-0305e82c3301'))
      .toBe('//registry.npmjs.org/:_authToken=[REDACTED]');
    expect(redactBugReportSensitiveText('//registry.acme.dev/:_auth=dXNlcjpwYXNzd29yZA=='))
      .toBe('//registry.acme.dev/:_auth=[REDACTED]');
    expect(redactBugReportSensitiveText('//registry.acme.dev/:_password=aHVudGVyMg=='))
      .toBe('//registry.acme.dev/:_password=[REDACTED]');
    expect(redactBugReportSensitiveText('npm ERR! _authToken missing from .npmrc'))
      .toBe('npm ERR! _authToken missing from .npmrc');
  });

  it('redacts an AWS session token alongside the paired secret access key', () => {
    expect(redactBugReportSensitiveText('AWS_SESSION_TOKEN=IQoJb3JpZ2luX2VjEHoaCXVzLWVhc3QtMSJH'))
      .toBe('AWS_SESSION_TOKEN: [REDACTED]');
    expect(redactBugReportSensitiveText('aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))
      .toBe('aws_secret_access_key: [REDACTED]');
    expect(redactBugReportSensitiveText('aws region us-east-1 unavailable'))
      .toBe('aws region us-east-1 unavailable');
  });

  it('redacts Slack bot tokens and incoming webhook URLs', () => {
    expect(redactBugReportSensitiveText('slack post failed for xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrSt'))
      .toBe('slack post failed for [REDACTED]');
    expect(redactBugReportSensitiveText('POST https://hooks.slack.com/services/T00000000/B11111111/AbCdEfGhIjKlMnOpQrStUvWx'))
      .toBe('POST https://hooks.slack.com/services/[REDACTED]');
    expect(redactBugReportSensitiveText('see https://acme.slack.com/archives/C0123 for context'))
      .toBe('see https://acme.slack.com/archives/C0123 for context');
  });

  it('redacts Stripe secret and restricted keys but keeps publishable identifiers', () => {
    expect(redactBugReportSensitiveText('charge failed with sk_live_51H8xKqABCDEFghijkLMNOP0123456789'))
      .toBe('charge failed with [REDACTED]');
    expect(redactBugReportSensitiveText('rk_test_51H8xKqABCDEFghijkLMNOP0123456789 lacks scope'))
      .toBe('[REDACTED] lacks scope');
    expect(redactBugReportSensitiveText('pk_live_51H8xKqABCDEFghijkLMNOP0123456789 is publishable'))
      .toBe('pk_live_51H8xKqABCDEFghijkLMNOP0123456789 is publishable');
  });

  it('redacts Google API keys and GitHub fine-grained personal access tokens', () => {
    expect(redactBugReportSensitiveText('key AIzaSyA1B2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q rejected'))
      .toBe('key [REDACTED] rejected');
    expect(redactBugReportSensitiveText('auth github_pat_11ABCDEFG0abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789 failed'))
      .toBe('auth [REDACTED] failed');
    expect(redactBugReportSensitiveText('AIzaSy is not a key by itself')).toBe('AIzaSy is not a key by itself');
  });

  it('redacts a GitLab personal access token that no label or URL announces', () => {
    // A `glpat-` token only had to appear outside a clone URL to survive: the
    // generic `token` rule needs a word boundary the `GITLAB_TOKEN` underscore
    // denies it, so an environment dump published the credential verbatim.
    expect(redactBugReportSensitiveText('push rejected for glpat-ABCDEFGHIJKLMNOPQRST on gitlab.com'))
      .toBe('push rejected for [REDACTED] on gitlab.com');
    expect(redactBugReportSensitiveText('GITLAB_TOKEN=glpat-ABCDEFGHIJKLMNOPQRST'))
      .toBe('GITLAB_TOKEN=[REDACTED]');
    expect(redactBugReportSensitiveText('glpat- is the GitLab token prefix, and glpat-short is not a token'))
      .toBe('glpat- is the GitLab token prefix, and glpat-short is not a token');
  });

  it('redacts the Slack app-level and Google OAuth tokens their vendor rules missed', () => {
    // Both vendors were already covered by one prefix each — `xox…` and `AIza` —
    // and each has a second, equally distinctive credential prefix that the
    // covering rule cannot match.
    expect(redactBugReportSensitiveText('socket mode failed for xapp-1-A012BC3DE4F-1234567890123-abcdef0123456789abcdef'))
      .toBe('socket mode failed for [REDACTED]');
    expect(redactBugReportSensitiveText('refresh failed for ya29.a0AfH6SMBx0123456789abcdefghijklmnopqrstuvwxyz'))
      .toBe('refresh failed for [REDACTED]');
    expect(redactBugReportSensitiveText('xapp- and ya29 name the prefixes; neither is a credential'))
      .toBe('xapp- and ya29 name the prefixes; neither is a credential');
  });

  it('redacts the registry and model-hub tokens a local install pulls with', () => {
    // `hf_` is one of the families `redactsProcessArgs: true` already advertises
    // in apps/cli/src/daemon/local/services/inventory/provenance.ts, so a bug
    // report was disclosing a credential the process projection removes.
    expect(redactBugReportSensitiveText('docker login failed with dckr_pat_AbCdEfGhIjKlMnOpQrStUvWxYz0'))
      .toBe('docker login failed with [REDACTED]');
    expect(redactBugReportSensitiveText('model download denied for hf_0000000000000000000000000000000000'))
      .toBe('model download denied for [REDACTED]');
    expect(redactBugReportSensitiveText('docker pull ghcr.io/acme/happier:1.2.3 denied'))
      .toBe('docker pull ghcr.io/acme/happier:1.2.3 denied');
    expect(redactBugReportSensitiveText('hf_cache and dckr_pat_ are names, not values'))
      .toBe('hf_cache and dckr_pat_ are names, not values');
  });

  it('leaves real repository identifiers and prose near the new prefixes untouched', () => {
    // Each new rule keys on a distinctive literal prefix followed by a credential
    // -length body. Nothing this repository writes satisfies both.
    const text = [
      'SessionTranscriptObservationProvenanceV1',
      'ConnectedServiceCredentialRecordV1Schema',
      'packages/protocol/src/bugs/reports/redaction.ts',
      'apps/cli/src/utils/crypto/aes256GcmBytes.test.ts',
      'the gitlab, slack, google and docker integrations all reported 40 warnings',
      'dckr_pat_ and glpat- and xapp- and ya29. are prefixes, not values',
    ].join('\n');

    expect(redactBugReportSensitiveText(text)).toBe(text);
  });

  it('redacts a PEM private key body but keeps a public certificate block', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfnygWyF0dEXAMPLEKEYBODYLINEONE',
      'AQEA0Z3VS5JJcds3xfnygWyF0dEXAMPLEKEYBODYLINETWOxyzAQAB',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

    const redacted = redactBugReportSensitiveText(pem);
    expect(redacted).not.toContain('EXAMPLEKEYBODY');
    expect(redacted).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(redacted).toContain('[REDACTED]');

    const certificate = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+w==\n-----END CERTIFICATE-----';
    expect(redactBugReportSensitiveText(certificate)).toBe(certificate);
  });

  it('redacts a PEM private key body larger than any repetition bound', () => {
    const body = 'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfnygWyF0dEXAMPLEKEYBODY'.repeat(4_000);
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;

    expect(body.length).toBeGreaterThan(65_536);
    const redacted = redactBugReportSensitiveText(pem);

    expect(redacted).not.toContain('EXAMPLEKEYBODY');
    expect(redacted).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(redacted).toContain('-----END RSA PRIVATE KEY-----');
  });

  it('redacts a truncated PEM private key whose end marker never arrives', () => {
    const truncated = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU';
    const redacted = redactBugReportSensitiveText(truncated);

    expect(redacted).not.toContain('b3BlbnNzaC1rZXktdjEA');
    expect(redacted).toContain('-----BEGIN OPENSSH PRIVATE KEY-----');
  });
});

describe('identifiers that must never be mistaken for secrets', () => {
  it('keeps digests, subresource integrity values, uuids, paths and prose intact', () => {
    const text = [
      'da39a3ee5e6b4b0d3255bfef95601890afd80709',
      'DA39A3EE5E6B4B0D3255BFEF95601890AFD80709',
      '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
      'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC',
      'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      '/Users/alice/projects/acme/.happier-plugin/plugin.json',
      'the build finished in 40 seconds with 3 warnings and no errors reported',
    ].join('\n');

    expect(redactBugReportSensitiveText(text)).toBe(text);
  });
});
