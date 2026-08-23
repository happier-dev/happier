import { describe, expect, it } from 'vitest';

import {
  parseGeneratorCliArgs,
  resolveSelectedBundledPluginPackageNames,
  shouldHoldGeneratorWorkspaceLockDuringGeneration,
} from './options.ts';

describe('bundled Plugin publisher options', () => {
  it('keeps read-only projection checks concurrent and write publication locked', () => {
    expect(shouldHoldGeneratorWorkspaceLockDuringGeneration('check')).toBe(false);
    expect(shouldHoldGeneratorWorkspaceLockDuringGeneration('write')).toBe(true);
  });

  it('normalizes targeted workspace names without duplicating them', () => {
    expect(parseGeneratorCliArgs([
      '--mode', 'check',
      '--scope', 'projections',
      '--workspace', '@happier-dev/plugins-codex',
      '--workspace', 'plugins-codex',
    ])).toMatchObject({
      mode: 'check',
      scope: 'projections',
      workspaceNames: ['plugins-codex'],
      aggregateOnly: false,
    });
  });

  it('rejects write-time narrowed scope and unpublished targets', () => {
    expect(() => parseGeneratorCliArgs(['--scope', 'projections'])).toThrow(/check-only scope/u);
    expect(() => resolveSelectedBundledPluginPackageNames(
      ['@happier-dev/plugins-codex'],
      ['plugins-missing'],
    )).toThrow(/not published/u);
  });
});
