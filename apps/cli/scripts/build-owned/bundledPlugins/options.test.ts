import { describe, expect, it } from 'vitest';

import {
  parseGeneratorCliArgs,
  resolvePluginAuthorRuntimeLoadScope,
  resolveSelectedBundledPluginPackageNames,
  shouldEvaluateBundledRuntimeSource,
  shouldHoldGeneratorWorkspaceLockDuringGeneration,
} from './options.ts';

describe('bundled Plugin publisher options', () => {
  it('keeps read-only projection checks concurrent and write publication locked', () => {
    expect(shouldHoldGeneratorWorkspaceLockDuringGeneration('check')).toBe(false);
    expect(shouldHoldGeneratorWorkspaceLockDuringGeneration('write')).toBe(true);
  });

  it('does not evaluate executable runtime source for projection-only checks', () => {
    expect(shouldEvaluateBundledRuntimeSource('projections')).toBe(false);
    expect(shouldEvaluateBundledRuntimeSource('all')).toBe(true);
  });

  it('loads the authoring runtime only for source-based projection work', () => {
    expect(resolvePluginAuthorRuntimeLoadScope({ aggregateOnly: true, scope: 'all' })).toBe('none');
    expect(resolvePluginAuthorRuntimeLoadScope({ aggregateOnly: false, scope: 'projections' })).toBe('manifest');
    expect(resolvePluginAuthorRuntimeLoadScope({ aggregateOnly: false, scope: 'all' })).toBe('full');
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
