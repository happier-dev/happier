import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  getVendorResumeSupport,
  resolveProviderSessionRuntimePreferences,
} from './catalogHooks';

describe('session runtime catalog hooks', () => {
  it('resolves provider runtime preferences from catalog entries', async () => {
    const source = await readFile(new URL('./catalogHooks.ts', import.meta.url), 'utf8');
    const file = ts.createSourceFile('catalogHooks.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const eagerAgentCatalogs = file.statements.filter(statement => (
      ts.isImportDeclaration(statement)
      && !statement.importClause?.isTypeOnly
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === '@happier-dev/agents'
    ));
    expect(eagerAgentCatalogs).toHaveLength(0);
    await expect(resolveProviderSessionRuntimePreferences('kilo', {
      isExplicitCliSubcommand: true,
      parsed: { agentArgs: [] },
      settings: {},
      pluginSettings: {},
      environment: {},
      startOrigin: 'terminal',
    })).resolves.toEqual({});
  });

  it('keeps runtime-checked experimental vendor resume providers enabled', async () => {
    const ohMyPiSupportsResume = await getVendorResumeSupport('ohMyPi');
    const supportsResume = await getVendorResumeSupport('cursor');
    const kiroSupportsResume = await getVendorResumeSupport('kiro');

    expect(ohMyPiSupportsResume({})).toBe(true);
    expect(supportsResume({})).toBe(true);
    expect(kiroSupportsResume({})).toBe(false);
  });
});
