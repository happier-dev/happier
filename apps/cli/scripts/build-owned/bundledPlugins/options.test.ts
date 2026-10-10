import { describe, expect, it } from 'vitest';

import {
  parseGeneratorCliArgs,
  normalizeCanonicalGeneratorPublication,
  resolvePluginAuthorRuntimeLoadScope,
  resolveSelectedBundledPluginPackageNames,
  shouldEvaluateBundledRuntimeSource,
} from './options.ts';

describe('bundled Plugin publisher options', () => {
  it('gives direct and shared-dependency all-plugin writes one canonical publication', () => {
    const argv = ['--mode', 'write', '--workspace', '@happier-dev/plugins-codex', '--workspace', 'plugins-claude'];
    const normalized = normalizeCanonicalGeneratorPublication(argv, parseGeneratorCliArgs(argv), ['plugins-claude', 'plugins-codex']);
    expect(normalized.options).toEqual(parseGeneratorCliArgs(['--mode', 'write']));
    expect(parseGeneratorCliArgs(normalized.argv)).toEqual(normalized.options);
    for (const args of [
      ['--workspace', 'plugins-codex'],
      ['--mode', 'check', '--workspace', 'plugins-codex', '--workspace', 'plugins-claude'],
      ['--target-owned-only', '--workspace', 'plugins-codex', '--workspace', 'plugins-claude'],
    ]) {
      const options = parseGeneratorCliArgs(args);
      expect(normalizeCanonicalGeneratorPublication(args, options, ['plugins-claude', 'plugins-codex']))
        .toEqual({ argv: args, options });
    }
  });
  it('publishes source Agent facts without preparing executable runtimes', () => {
    const options = parseGeneratorCliArgs(['--agent-definitions']);
    expect(options).toMatchObject({ agentDefinitionsOnly: true, mode: 'write' });
    expect(resolvePluginAuthorRuntimeLoadScope(options)).toBe('none');
    expect(() => parseGeneratorCliArgs(['--agent-definitions', '--aggregate'])).toThrow();
    expect(() => parseGeneratorCliArgs(['--agent-definitions', '--workspace', 'plugins-claude'])).toThrow();
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

  it('retains only the semantic projection check as a public scope', () => {
    expect(parseGeneratorCliArgs(['--mode', 'check'])).toMatchObject({
      mode: 'check',
      scope: 'projections',
    });
    expect(parseGeneratorCliArgs(['--mode', 'write'])).toMatchObject({
      mode: 'write',
      scope: 'all',
    });
    expect(parseGeneratorCliArgs(['--mode', 'write', '--package-artifacts'])).toMatchObject({ scope: 'all' });
    expect(() => parseGeneratorCliArgs(['--package-artifacts', '--scope', 'projections'])).toThrow();
    expect(() => parseGeneratorCliArgs(['--mode', 'check', '--scope', 'all']))
      .toThrow(/scope.*projections/u);
  });

  it('admits target-owned publication only for a targeted write', () => {
    expect(parseGeneratorCliArgs([
      '--mode', 'write',
      '--workspace', 'plugins-codex',
      '--target-owned-only',
    ])).toMatchObject({
      mode: 'write',
      workspaceNames: ['plugins-codex'],
      targetOwnedOnly: true,
    });
    expect(() => parseGeneratorCliArgs(['--target-owned-only']))
      .toThrow(/target-owned-only.*workspace/u);
    expect(() => parseGeneratorCliArgs([
      '--mode', 'check',
      '--workspace', 'plugins-codex',
      '--target-owned-only',
    ])).toThrow(/target-owned-only.*write/u);
  });

  it('rejects write-time narrowed scope and unpublished targets', () => {
    expect(() => parseGeneratorCliArgs(['--scope', 'projections'])).toThrow(/check-only scope/u);
    expect(() => resolveSelectedBundledPluginPackageNames(
      ['@happier-dev/plugins-codex'],
      ['plugins-missing'],
    )).toThrow(/not published/u);
  });
});
