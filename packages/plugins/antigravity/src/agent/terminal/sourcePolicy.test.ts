import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function readSourceFiles(dir: string): string {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) return readSourceFiles(path);
      return path.endsWith('.ts') && !path.endsWith('.test.ts')
        ? [readFileSync(path, 'utf8')]
        : [];
    })
    .join('\n');
}

describe('Antigravity terminal source policy', () => {
  it('does not claim print mode or private conversation storage as the production runtime', () => {
    const source = readSourceFiles(new URL('.', import.meta.url).pathname);
    const storageTerms = ['conversations\\.db', 'sql' + 'ite', 'proto' + 'buf'].join('|');
    const printTerms = ['agy\\s+-p', '--' + 'print'].join('|');
    const unsafePermissionFlag = 'dangerously' + '-skip-permissions';

    expect(source).not.toMatch(new RegExp(storageTerms, 'i'));
    expect(source).not.toMatch(new RegExp(printTerms));
    expect(source).not.toMatch(new RegExp(unsafePermissionFlag));
  });
});
