import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isForbiddenBrowserEgressKey, rejectUnsafeBrowserEgressKeys } from './keyRejection.js';

// L2-4: the canonical rejector must reject the SUPERSET of every key any of the three collapsed
// clones rejected. The automation clone rejected inline-screenshot/bundle/snapshot/storage keys;
// the diagnostics/context clones accepted them — that divergence was a real leak shape.
const KEYS_REJECTED_BY_ANY_LEGACY_CLONE = [
  // shared unsafe-telemetry family (all three clones)
  'authorization',
  'cookie',
  'cookies',
  'body',
  'payload',
  'requestBody',
  'response_body',
  'localStorage',
  'sessionStorage',
  'token',
  'apiKey',
  'previewToken',
  // automation-only additions (the divergence)
  'screenshotDataUri',
  'diagnosticsBundle',
  'domSnapshot',
  'dom_snapshot',
  'pageDomSnapshotHtml',
];

const ACCEPTED_KEYS = ['url', 'statusCode', 'requestId', 'storageType', 'keyCount', 'level'];

function collectSourceFiles(directory: string): string[] {
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

function collectIssuePaths(value: unknown): string[] {
  const schema = z.unknown().superRefine((v, ctx) => rejectUnsafeBrowserEgressKeys(v, ctx));
  const result = schema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join('.'));
}

describe('isForbiddenBrowserEgressKey — superset contract', () => {
  it.each(KEYS_REJECTED_BY_ANY_LEGACY_CLONE)('rejects %s', (key) => {
    expect(isForbiddenBrowserEgressKey(key)).toBe(true);
  });

  it.each(ACCEPTED_KEYS)('keeps benign key %s', (key) => {
    expect(isForbiddenBrowserEgressKey(key)).toBe(false);
  });
});

describe('browser egress rejector closure', () => {
  it('has exactly one rejector owner and no browser-local record guard clones', () => {
    const browserRoot = fileURLToPath(new URL('../../', import.meta.url));
    const browserFiles = collectSourceFiles(browserRoot);
    const commonRecords = readFileSync(
      fileURLToPath(new URL('../../../common/records.ts', import.meta.url)),
      'utf8',
    );

    expect(countMatches(browserFiles, /export function rejectUnsafeBrowserEgressKeys\s*\(/g)).toBe(1);
    expect(countMatches(browserFiles, /\bfunction isRecord\s*\(/g)).toBe(0);
    expect(commonRecords.match(/export function isRecord\s*\(/g)?.length ?? 0).toBe(1);
  });
});

describe('rejectUnsafeBrowserEgressKeys', () => {
  it('rejects forbidden keys at any nesting depth, including inside arrays', () => {
    const paths = collectIssuePaths({
      fine: { list: [{ screenshotDataUri: 'data:...' }, { deep: { cookie: 'a=b' } }] },
    });
    expect(paths).toContain('fine.list.0.screenshotDataUri');
    expect(paths).toContain('fine.list.1.deep.cookie');
  });

  it('accepts clean payloads', () => {
    expect(collectIssuePaths({ url: 'https://x.test', statusCode: 200, nested: { keys: ['a'] } })).toEqual([]);
  });

  it('carries the caller-supplied message', () => {
    const schema = z.unknown().superRefine((v, ctx) =>
      rejectUnsafeBrowserEgressKeys(v, ctx, { message: 'custom-rejection' }));
    const result = schema.safeParse({ token: 'x' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('custom-rejection');
    }
  });
});
