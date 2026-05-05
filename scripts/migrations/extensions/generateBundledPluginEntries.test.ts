import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { main as generateBundledPluginEntries } from './generateBundledPluginEntries.ts';

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('generateBundledPluginEntries writes deterministic bundled plugin contribution outputs', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-'));

  writeJson(resolve(repoRoot, 'packages/plugins/claude/package.json'), {
    name: '@happier-dev/plugins-claude',
    version: '0.0.0',
  });
  writeJson(resolve(repoRoot, 'packages/plugins/codex/package.json'), {
    name: '@happier-dev/plugins-codex',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/manifest.ts'),
    'export const PLUGIN_MANIFEST = Object.freeze({ id: "claude", runtime: { capabilities: ["agents"] }, contributes: {} });\n',
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/agent/definition.ts'),
    'export const AGENT_DEFINITION = Object.freeze({ id: \"claude\" });\n',
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/manifest.ts'),
    'export const PLUGIN_MANIFEST = Object.freeze({ id: "codex", runtime: { capabilities: ["agents"] }, contributes: {} });\n',
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/agent/definition.ts'),
    'export const AGENT_DEFINITION = Object.freeze({ id: \"codex\" });\n',
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  // Minimal UI file with a replaceable constant.
  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    [
      'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);',
      'export const SOME_OTHER_EXPORT = 123;',
      '',
    ].join('\n'),
    'utf8',
  );

  // Minimal type file for generated aggregate typing.
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_PROVIDER_CONTRIBUTIONS/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_BACKEND_CONTRIBUTIONS/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS/);
  assert.match(cliOut, /@happier-dev\/plugins-claude/);
  assert.match(cliOut, /@happier-dev\/plugins-codex/);
  assert.ok(
    cliOut.indexOf('@happier-dev/plugins-claude') < cliOut.indexOf('@happier-dev/plugins-codex'),
    'expected lexical order',
  );

  const uiOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'utf8',
  );
  assert.match(uiOut, /SOME_OTHER_EXPORT/);
  assert.match(uiOut, /@happier-dev\/plugins-claude/);

  const uiBehaviorOverridesOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.uiBehaviorOverrides.ts'),
    'utf8',
  );
  assert.match(uiBehaviorOverridesOut, /BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_OVERRIDES/);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  assert.match(agentsOut, /BUNDLED_AGENT_DEFINITION_IDS/);
  assert.match(agentsOut, /BUNDLED_AGENT_DEFINITIONS_BY_ID/);
  assert.match(agentsOut, /\bbundledAgentDefinitions\b/);
  assert.match(agentsOut, /"claude":\s*Object\.freeze\(\(\{/);
  assert.match(agentsOut, /\}\) as const\),\n\s+"codex":/);
  assert.match(agentsOut, /"claude":\s*Object\.freeze\(/);
  assert.match(agentsOut, /"codex":\s*Object\.freeze\(/);
  assert.match(agentsOut, /"id":\s*"claude"/);
  assert.match(agentsOut, /"id":\s*"codex"/);

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);
});

test('generateBundledPluginEntries skips reservation-only plugin packages', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-skip-'));

  writeJson(resolve(repoRoot, 'packages/plugins/claude/package.json'), {
    name: '@happier-dev/plugins-claude',
    version: '0.0.0',
  });
  writeJson(resolve(repoRoot, 'packages/plugins/placeholder/package.json'), {
    name: '@happier-dev/plugins-placeholder',
    version: '0.0.0',
    happier: {
      extensionScaffold: {
        shipping: 'reservation_only',
        plannedStage: 'E.99',
      },
    },
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/manifest.ts'),
    'export const PLUGIN_MANIFEST = Object.freeze({ id: "claude", runtime: { capabilities: ["agents"] }, contributes: {} });\n',
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/claude/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/claude/src/agent/definition.ts'),
    'export const AGENT_DEFINITION = Object.freeze({ id: \"claude\" });\n',
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /@happier-dev\/plugins-claude/);
  assert.doesNotMatch(cliOut, /@happier-dev\/plugins-placeholder/);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  assert.match(agentsOut, /"claude":\s*Object\.freeze\(/);
  assert.doesNotMatch(agentsOut, /placeholder/);
});

test('generateBundledPluginEntries projects non-agent plugin packages without agent definitions', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-non-agent-'));

  writeJson(resolve(repoRoot, 'packages/plugins/scm-github/package.json'), {
    name: '@happier-dev/plugins-scm-github',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/scm-github/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/scm-github/src/manifest.ts'),
    [
      'export const PLUGIN_MANIFEST = Object.freeze({',
      '  schemaVersion: 2,',
      '  id: "scm-github",',
      '  version: "0.0.0",',
      '  runtime: { apiVersion: 1, capabilities: ["scmHostingProviders"] },',
      '  contributes: { scmHostingProviders: [{ id: "github", kind: "github", displayName: "GitHub" }] },',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const cliOut = readFileSync(
    resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /@happier-dev\/plugins-scm-github/);
  assert.match(cliOut, /"pluginId":\s*"scm-github"/);
  assert.doesNotMatch(cliOut, /"agentId":\s*"scm-github"/);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  assert.doesNotMatch(agentsOut, /scm-github/);
});

test('generateBundledPluginEntries fails for agent-capable plugin packages without agent definitions', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-missing-definition-'));

  writeJson(resolve(repoRoot, 'packages/plugins/placeholder/package.json'), {
    name: '@happier-dev/plugins-placeholder',
    version: '0.0.0',
  });
  mkdirSync(resolve(repoRoot, 'packages/plugins/placeholder/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/placeholder/src/manifest.ts'),
    [
      'export const PLUGIN_MANIFEST = Object.freeze({',
      '  schemaVersion: 2,',
      '  id: "placeholder",',
      '  version: "0.0.0",',
      '  runtime: { apiVersion: 1, capabilities: ["agents"] },',
      '  contributes: {},',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );

  await assert.rejects(
    () => generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /Missing required agent definition/,
  );
});

test('generateBundledPluginEntries uses AGENT_DEFINITION.id as the runtime agent id', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-runtime-id-'));

  writeJson(resolve(repoRoot, 'packages/plugins/ohmypi/package.json'), {
    name: '@happier-dev/plugins-ohmypi',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/ohmypi/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/ohmypi/src/manifest.ts'),
    [
      'export const PLUGIN_MANIFEST = Object.freeze({',
      '  schemaVersion: 2,',
      '  id: "ohmypi",',
      '  version: "0.0.0",',
      '  runtime: { apiVersion: 1, capabilities: ["agents"] },',
      '  contributes: {},',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/ohmypi/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/ohmypi/src/agent/definition.ts'),
    'export const AGENT_DEFINITION = Object.freeze({ id: \"ohMyPi\" });\n',
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'apps/cli/src/plugins/projection/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'export const BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: readonly string[] = Object.freeze([]);\n',
    'utf8',
  );
  writeFileSync(
    resolve(repoRoot, 'packages/agents/src/definitions/agentDefinition.ts'),
    'export type AgentDefinition = Readonly<{ id: string } & Record<string, unknown>>;\n',
    'utf8',
  );

  await generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  assert.match(agentsOut, /"ohMyPi":\s*Object\.freeze\(/);
  assert.match(agentsOut, /"id":\s*"ohMyPi"/);
  assert.doesNotMatch(agentsOut, /"ohmypi":\s*Object\.freeze\(/);
});
