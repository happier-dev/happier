import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function writeGovernanceReports(entries: Readonly<Record<string, string>>, rootDir: string = process.cwd()): void {
  for (const [relativePath, content] of Object.entries(entries)) {
    const absolutePath = join(rootDir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
  }
}
