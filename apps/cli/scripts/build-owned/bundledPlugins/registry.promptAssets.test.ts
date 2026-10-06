import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { resolveTypeScriptCliInvocation } from '../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

import { renderCliPromptAssetPluginDescriptorsTs } from './registry';
import { renderBundledPluginTranslationsTs, renderBundledUiBehaviorOverridesTs } from './agentUi';
import type { JsonObject } from './projectionFacts';
import { CLAUDE_PREDECESSOR_MESSAGE_META_DEFAULTS, buildClaudePredecessorMessageMeta as buildPluginMeta } from '../../../../../packages/plugins/claude/src/ui/predecessorMessageMeta';
import { buildClaudePredecessorMessageMeta } from '@happier-dev/protocol/agents/claude/predecessor-message-meta';

describe('bundled prompt asset projection', () => {
  it('publishes descriptor data without an executable plugin import', () => {
    const descriptor = {
      adapterKind: 'markdownDoc', assetTypeId: 'claude.command', providerId: 'claude',
      title: 'Commands', description: 'Slash commands',
      projectRootPath: ['.claude', 'commands'], projectRootDisplayPath: '.claude/commands',
      userRootPath: ['.claude', 'commands'], userRootDisplayPath: '~/.claude/commands',
    };
    const output = renderCliPromptAssetPluginDescriptorsTs([{
      pluginPackageId: 'claude',
      descriptors: [descriptor],
    }]);
    expect(output).not.toContain('@happier-dev/plugins-claude');
    const serialized = output.match(/Object\.freeze\(([\s\S]*)\);/u)?.[1];
    expect(JSON.parse(serialized!)).toEqual([descriptor]);
    const excluded = renderCliPromptAssetPluginDescriptorsTs([]);
    expect(JSON.parse(excluded.match(/Object\.freeze\(([\s\S]*)\);/u)![1]!)).toEqual([]);
  });
});

describe('bundled translation projection', () => {
  it('emits portable declarations for the published bundles while retaining exact translation keys', () => {
    const repoRoot = resolve(__dirname, '../../../../..');
    const published = ts.createSourceFile('translations.ts', readFileSync(join(repoRoot,
      'apps/ui/sources/text/bundledPluginTranslations.generated.ts'), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let translations: JsonObject | undefined;
    for (const statement of published.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText(published) !== 'BUNDLED_PLUGIN_TRANSLATIONS') continue;
        const initializer = declaration.initializer;
        if (!initializer || !ts.isCallExpression(initializer)) continue;
        const argument = initializer.arguments[0];
        if (!argument) continue;
        const literal = ts.isAsExpression(argument) ? argument.expression : argument;
        translations = JSON.parse(literal.getText(published)) as JsonObject;
      }
    }
    expect(translations).toBeDefined();
    const fixture = mkdtempSync(join(tmpdir(), 'happier-projected-translations-'));
    try {
      writeFileSync(join(fixture, 'projection.ts'), renderBundledPluginTranslationsTs(translations!));
      const firstLocale = Object.keys(translations!)[0]!;
      const firstBundle = translations![firstLocale] as JsonObject;
      const firstKey = Object.keys(firstBundle)[0]!;
      const keys = [...new Set(Object.values(translations!).flatMap((bundle) => Object.keys(bundle as JsonObject)))];
      writeFileSync(join(fixture, 'consumer.ts'), [
        "import { BUNDLED_PLUGIN_TRANSLATIONS, type BundledPluginTranslationKey } from './projection';",
        `export const key: BundledPluginTranslationKey = ${JSON.stringify(firstKey)};`,
        `export const keys: readonly BundledPluginTranslationKey[] = ${JSON.stringify(keys)};`,
        `export const value: string = BUNDLED_PLUGIN_TRANSLATIONS[${JSON.stringify(firstLocale)}][key];`,
        '// @ts-expect-error Unknown translation keys must not be admitted by declaration materialization.',
        "export const invalidKey: BundledPluginTranslationKey = '__unknown_ci03_translation__';",
        '// @ts-expect-error The table itself retains the published key boundary.',
        `export const invalidTableKey: keyof typeof BUNDLED_PLUGIN_TRANSLATIONS[${JSON.stringify(firstLocale)}] = '__unknown_ci03_translation__';`,
        '// @ts-expect-error Translation values remain strings rather than untyped data.',
        `export const invalidValue: number = BUNDLED_PLUGIN_TRANSLATIONS[${JSON.stringify(firstLocale)}][key];`,
      ].join('\n'));
      writeFileSync(join(fixture, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          strict: true, declaration: true, emitDeclarationOnly: true, skipLibCheck: true, types: [],
          module: 'preserve', moduleResolution: 'bundler', target: 'es2022', outDir: './dist',
        },
        files: ['projection.ts', 'consumer.ts'],
      }));
      const invocation = resolveTypeScriptCliInvocation({ repoRoot, workspaceDir: join(repoRoot, 'apps/cli') });
      const result = spawnSync(invocation.command, [...invocation.argsPrefix,
        '--project', join(fixture, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8' });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(join(fixture, 'dist/projection.d.ts'), 'utf8')).toContain('BundledPluginTranslationKey');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('bundled predecessor message metadata projection', () => {
  it('publishes defaults usable by the canonical predecessor writer when the plugin has additional settings', () => {
    const repoRoot = resolve(__dirname, '../../../../..');
    const fixture = mkdtempSync(join(tmpdir(), 'happier-projected-predecessor-'));
    try {
      const output = renderBundledUiBehaviorOverridesTs([{
        agentId: 'claude', descriptor: {},
        predecessorMessageMetaWriter: {
          importName: 'buildClaudePredecessorMessageMeta',
          importPath: '@happier-dev/protocol/agents/claude/predecessor-message-meta',
          defaults: CLAUDE_PREDECESSOR_MESSAGE_META_DEFAULTS,
        },
      }]);
      writeFileSync(join(fixture, 'projection.ts'), output);
      // This fixture has one bundled Agent; the real Protocol writer declaration
      // below decides which projected settings its caller must provide.
      writeFileSync(join(fixture, 'registryCore.ts'), "export type CanonicalAgentId = 'claude';\n");
      writeFileSync(join(fixture, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          strict: true, noEmit: true, skipLibCheck: true, types: [],
          module: 'preserve', moduleResolution: 'bundler', target: 'es2022',
          paths: { '@happier-dev/protocol/agents/claude/predecessor-message-meta': [
            join(repoRoot, 'packages/protocol/dist/agents/claude/predecessorMessageMeta.d.ts'),
          ] },
        },
        files: ['projection.ts', 'registryCore.ts'],
      }));
      const invocation = resolveTypeScriptCliInvocation({ repoRoot, workspaceDir: join(repoRoot, 'apps/cli') });
      const result = spawnSync(invocation.command, [...invocation.argsPrefix,
        '--project', join(fixture, 'tsconfig.json'), '--pretty', 'false'], { encoding: 'utf8' });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('keeps the compatibility writer independent of executable plugin packages', () => {
    const output = renderBundledUiBehaviorOverridesTs([{
      agentId: 'claude', descriptor: {},
      predecessorMessageMetaWriter: {
        importName: 'buildClaudePredecessorMessageMeta',
        importPath: '@happier-dev/protocol/agents/claude/predecessor-message-meta',
        defaults: { claudeRemoteAgentSdkEnabled: true },
      },
    }]);
    expect(output).not.toContain('@happier-dev/plugins-claude');
    // A bound constant, not a fresh literal: later plugin settings must not trip
    // the protocol defaults type's excess-property check.
    expect(output).toContain('buildClaudePredecessorMessageMeta(settings, CLAUDE_PREDECESSOR_MESSAGE_META_DEFAULTS)');
    expect(output).toContain('"claudeRemoteAgentSdkEnabled": true');
    expect(renderBundledUiBehaviorOverridesTs([])).not.toContain('buildClaudePredecessorMessageMeta');
  });

  it('preserves the present-plugin writer through projected defaults, including malformed settings', () => {
    const output = renderBundledUiBehaviorOverridesTs([{
      agentId: 'claude', descriptor: {},
      predecessorMessageMetaWriter: {
        importName: 'buildClaudePredecessorMessageMeta',
        importPath: '@happier-dev/protocol/agents/claude/predecessor-message-meta',
        defaults: CLAUDE_PREDECESSOR_MESSAGE_META_DEFAULTS,
      },
    }]);
    const projectedDefaults = JSON.parse(output.match(
      /_PREDECESSOR_MESSAGE_META_DEFAULTS = (\{[\s\S]*?\}) as const;/u,
    )![1]!);
    for (const settings of [{}, {
      claudeRemoteAgentSdkEnabled: false,
      claudeRemoteSettingSources: 'none',
      claudeRemoteAdvancedOptionsJson: ' { "betas": ["agent-teams"] } ',
    }, {
      claudeUnifiedTerminalHost: 'invalid',
      claudeRemoteSettingSourcesV2: ['invalid'],
      claudeRemoteDebugCategories: ['invalid'],
      claudeRemoteAdvancedOptionsJson: '[1]',
    }]) {
      expect(buildClaudePredecessorMessageMeta(settings, projectedDefaults)).toEqual(buildPluginMeta(settings));
    }
    expect(buildClaudePredecessorMessageMeta({
      claudeRemoteAgentSdkEnabled: false,
      claudeRemoteSettingSources: 'none',
    }, projectedDefaults)).toMatchObject({
      claudeRemoteAgentSdkEnabled: false, claudeRemoteSettingSources: 'none',
      claudeRemoteSettingSourcesV2: [],
    });
  });
});
