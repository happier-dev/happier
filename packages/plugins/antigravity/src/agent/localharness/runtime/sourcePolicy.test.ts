import { describe, expect, it } from 'vitest';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function readSourceFiles(root: string): string {
  let out = '';
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out += readSourceFiles(path);
    } else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
      out += `\n// ${path}\n${readFileSync(path, 'utf8')}`;
    }
  }
  return out;
}

describe('Antigravity localharness source policy', () => {
  it('keeps production runtime off remote API, agy print mode, private stores, keyrings, and private SDK imports', () => {
    const source = readSourceFiles(new URL('..', import.meta.url).pathname);
    const interactionsTerms = [
      'Interactions ' + 'API',
      'interactions\\.' + 'google',
      'generative' + 'language\\.' + 'googleapis',
    ].join('|');
    const printAndPrivateStorageTerms = [
      'agy\\s+-p',
      '--' + 'print',
      'conversations\\.db',
      'sql' + 'ite',
      'antigravity-cli\\/conversations',
    ].join('|');
    const privateCredentialStoreTerms = [
      'oauth_' + 'creds',
      'google_' + 'accounts',
      'antigravity-cli\\/oauth',
      '\\.gemini\\/oauth',
      'credsfile\\.' + 'ClientCredentialsFile',
    ].join('|');
    const unmanagedRuntimeTerms = [
      'python -m ' + 'pip',
      'pip ' + 'install',
      '@happier-dev\\/plugin-sdk\\/internal',
    ].join('|');

    expect(source).not.toMatch(new RegExp(interactionsTerms, 'i'));
    expect(source).not.toMatch(new RegExp(printAndPrivateStorageTerms, 'i'));
    expect(source).not.toMatch(new RegExp(privateCredentialStoreTerms, 'i'));
    expect(source).not.toMatch(new RegExp(unmanagedRuntimeTerms, 'i'));
    expect(source).not.toMatch(/createAntigravityLocalharnessBackendEngine/);
  });
});
