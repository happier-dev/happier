import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('first-party voice UI package boundary', () => {
  it('keeps vendor package imports inside the generated build-time projection', async () => {
    const root = new URL('../../', import.meta.url);
    const files: URL[] = [];
    const visit = async (directory: URL): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
        if (entry.isDirectory()) await visit(child);
        else if (/\.(?:ts|tsx)$/u.test(entry.name) && !/\.(?:test|spec)\.(?:ts|tsx)$/u.test(entry.name)) files.push(child);
      }
    };
    await visit(root);

    const violations: string[] = [];
    for (const file of files) {
      // The generated build-time projection is emitted per host platform by
      // `apps/cli/scripts/build-owned/generateBundledPluginEntries.ts`; every emitted
      // variant is the same generated boundary, not a hand-written import.
      if (/\/voice\/registry\/generatedBundledVoice(?:Entries|RuntimeEntries)(?:\.(?:web|ios|android))?\.ts$/u.test(file.pathname)) continue;
      const source = await readFile(file, 'utf8');
      if (
        source.includes('@happier-dev/plugins-elevenlabs/')
        || source.includes('@happier-dev/plugins-google/')
        || source.includes('@happier-dev/plugins-openai/')
        || source.includes('@happier-dev/plugins-xai/')
      ) {
        violations.push(file.pathname.slice(root.pathname.length));
      }
    }

    expect(violations).toEqual([]);
  });
});
