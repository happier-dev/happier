import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('retired generated Session-control projection', () => {
  it('keeps the bundled generator and public Agents surface contracted onto canonical owners', () => {
    const generatedAdapterPath = new URL('../../generated/sessionControlAdapters.ts', import.meta.url);
    const generatorSource = readFileSync(
      new URL('../../../../../apps/cli/scripts/build-owned/generateBundledPluginEntries.ts', import.meta.url),
      'utf8',
    );
    const publicSource = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');

    expect(existsSync(generatedAdapterPath)).toBe(false);
    expect(generatorSource).not.toContain('renderAgentSessionControlAdaptersTs');
    expect(generatorSource).not.toMatch(/\bconst sessionControlAdaptersOutPath\b/u);
    expect(generatorSource).toContain('const retiredSessionControlAdaptersOutPath');
    expect(generatorSource).toContain(
      'removeRetiredGeneratedOutput(retiredSessionControlAdaptersOutPath, options.mode)',
    );
    expect(publicSource).not.toContain('sessionControlAdapterRegistry');
    expect(publicSource).not.toContain('runtimeKindOverride.js');
    expect(publicSource).not.toContain('providerBackendModes.js');
  });
});
