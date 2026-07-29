import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

describe('local speech diagnostics privacy boundary', () => {
  it('does not import sync upload, analytics, crash-report, or provider-context owners', () => {
    const files = sourceFiles(join(process.cwd(), 'sources/voice/diagnostics'))
      .filter((path) => !path.endsWith('.test.ts'));
    const allowedEncryptedDownloadOwners = [
      '@/sync/domains/transfers/runtime/transferRuntime/carriers/downloadBulkPayloadViaMachineRpcToDestination',
      '@/sync/domains/transfers/runtime/transferRuntime/plumbing/bulkTransferFileDestination',
    ];
    const forbidden = [
      '@/sync/domains/transfers',
      '@/sync/api',
      '@/utils/system/sentry',
      '@/voice/context',
      'analytics',
      'crashReport',
    ];
    for (const file of files) {
      const imports = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => /^\s*import\b/.test(line))
        .filter((line) => !allowedEncryptedDownloadOwners.some((owner) => line.includes(owner)))
        .join('\n');
      for (const token of forbidden) expect(imports, `${file} must not import ${token}`).not.toContain(token);
    }
  });
});
