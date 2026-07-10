import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  isSensitiveUrlPathSegment,
  redactSensitiveUrlPathSegments,
  stripBrowserDiagnosticUrlValues,
  stripUrlValuesInString,
  SANITIZE_URL_PARITY_VECTORS,
} from './url.js';

const PATH_TOKEN = 'tok9f8e7d6c5b4a3210ffeeddcc';
const QUERY_TOKEN = 'sk_live_totally_secret_query_token';

function collectSourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    if (!entry.isFile() || !path.endsWith('.ts') || path.endsWith('.test.ts')) return [];
    return [path];
  });
}

function countMatches(files: readonly string[], pattern: RegExp): number {
  return files.reduce((count, file) => {
    const source = readFileSync(file, 'utf8');
    return count + (source.match(pattern)?.length ?? 0);
  }, 0);
}

describe('isSensitiveUrlPathSegment', () => {
  it.each([
    PATH_TOKEN,
    '123e4567-e89b-42d3-a456-426614174000',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.sig1234567890ab',
    'a1b2c3d4e5f6a7b8c9d0e1f2',
    '1234567890123456',
    'sk_live_abc123def456',
  ])('flags token-shaped segment %s', (segment) => {
    expect(isSensitiveUrlPathSegment(segment)).toBe(true);
  });

  it.each([
    'settings',
    'profile',
    'internationalization',
    '2026-07-08-release-notes',
    'v2',
    'api',
    'users',
  ])('keeps human-readable segment %s', (segment) => {
    expect(isSensitiveUrlPathSegment(segment)).toBe(false);
  });
});

describe('redactSensitiveUrlPathSegments', () => {
  it('replaces only the token segments, preserving structure', () => {
    expect(redactSensitiveUrlPathSegments(`/reset/${PATH_TOKEN}/confirm`)).toBe('/reset/:redacted/confirm');
    expect(redactSensitiveUrlPathSegments('/settings/profile')).toBe('/settings/profile');
  });
});

describe('stripBrowserDiagnosticUrlValues', () => {
  it('strips query, fragment, and token path segments from web URLs', () => {
    const out = stripBrowserDiagnosticUrlValues(`https://app.test/reset/${PATH_TOKEN}?token=${QUERY_TOKEN}#f`);
    expect(out).toBe('https://app.test/reset/:redacted');
  });

  it('strips query and token path segments from whole-value URL-encoded web URLs', () => {
    const encoded = encodeURIComponent(`https://app.test/reset/${PATH_TOKEN}?token=${QUERY_TOKEN}#f`);
    const out = stripBrowserDiagnosticUrlValues(encoded);
    expect(out).toBe('https://app.test/reset/:redacted');
  });

  it('reduces non-web schemes to the scheme', () => {
    expect(stripBrowserDiagnosticUrlValues('data:text/html;base64,AAAA')).toBe('data:');
    expect(stripBrowserDiagnosticUrlValues('javascript:void(0)')).toBe('javascript:');
  });

  it('redacts rooted paths', () => {
    expect(stripBrowserDiagnosticUrlValues(`/reset/${PATH_TOKEN}?x=1`)).toBe('/reset/:redacted');
  });

  it('best-efforts schemeless strings', () => {
    expect(stripBrowserDiagnosticUrlValues(`app.test/reset/${PATH_TOKEN}?x=1`)).toBe('app.test/reset/:redacted');
    expect(stripBrowserDiagnosticUrlValues('not a url at all')).toBe('not a url at all');
  });
});

describe('stripUrlValuesInString', () => {
  it('replaces embedded web URLs inside prose while keeping the prose', () => {
    const out = stripUrlValuesInString(`open https://app.test/reset/${PATH_TOKEN}?t=${QUERY_TOKEN} now`);
    expect(out).toBe('open https://app.test/reset/:redacted now');
  });

  it('replaces embedded URL-encoded web URLs inside prose while keeping the prose', () => {
    const encoded = encodeURIComponent(`https://app.test/reset/${PATH_TOKEN}?t=${QUERY_TOKEN}`);
    const out = stripUrlValuesInString(`open ${encoded} now`);
    expect(out).toBe('open https://app.test/reset/:redacted now');
  });

  it('collapses whole-value secret-capable schemes to the scheme', () => {
    expect(stripUrlValuesInString(`javascript:fetch('https://x.test/?t=${QUERY_TOKEN}')`)).toBe('javascript:');
    expect(stripUrlValuesInString('mailto:user@example.test')).toBe('mailto:');
  });

  it('redacts whole-value rooted URL paths', () => {
    expect(stripUrlValuesInString(`/reset/${PATH_TOKEN}?t=${QUERY_TOKEN}`)).toBe('/reset/:redacted');
  });

  it('redacts whole-value schemeless path-like URL values', () => {
    expect(stripUrlValuesInString(`app.test/reset/${PATH_TOKEN}?t=${QUERY_TOKEN}`)).toBe('app.test/reset/:redacted');
  });

  it('leaves plain prose and colon-bearing non-URL values alone', () => {
    expect(stripUrlValuesInString('note: something happened')).toBe('note: something happened');
    expect(stripUrlValuesInString('width:100px')).toBe('width:100px');
    expect(stripUrlValuesInString('12:30')).toBe('12:30');
  });
});

describe('parity vector sanity', () => {
  it('every parity vector produces a stable, token-free output', () => {
    for (const vector of SANITIZE_URL_PARITY_VECTORS) {
      const out = stripBrowserDiagnosticUrlValues(vector);
      expect(out).not.toContain('sk_live_secret');
      expect(out).not.toContain('tok9f8e7d6c5b4a3210ffeeddcc');
      expect(out).not.toContain('?');
      expect(out).not.toContain('#');
    }
  });
});

describe('browser diagnostics URL redactor closure', () => {
  it('has one exported TypeScript URL redactor outside the injected-page parity blob', () => {
    const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url));
    const files = [
      ...collectSourceFiles(join(repoRoot, 'packages/protocol/src/browser')),
      ...collectSourceFiles(join(repoRoot, 'apps/ui/sources/components/browser/adapters/diagnostics')),
    ];

    expect(countMatches(files, /\bfunction stripBrowserDiagnosticUrlValues\s*\(/g)).toBe(1);
  });
});
