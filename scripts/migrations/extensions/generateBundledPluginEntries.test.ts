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

test('generateBundledPluginEntries writes deterministic bundled package name outputs', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-'));

  writeJson(resolve(repoRoot, 'packages/extensions/claude/package.json'), { name: '@happier-dev/extensions-claude' });
  writeJson(resolve(repoRoot, 'packages/extensions/codex/package.json'), { name: '@happier-dev/extensions-codex' });

  mkdirSync(resolve(repoRoot, 'packages/extensions/claude/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/extensions/claude/src/agent/definition.ts'),
    'export const AGENT_DEFINITION = Object.freeze({ id: \"claude\" });\n',
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'packages/extensions/codex/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/extensions/codex/src/agent/definition.ts'),
    'export const AGENT_DEFINITION = Object.freeze({ id: \"codex\" });\n',
    'utf8',
  );

  mkdirSync(resolve(repoRoot, 'apps/cli/src/extensions/registry/sources'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'apps/ui/sources/agents/registry'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/generated'), { recursive: true });
  mkdirSync(resolve(repoRoot, 'packages/agents/src/definitions'), { recursive: true });

  // Minimal UI file with a replaceable constant.
  writeFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    [
      'export const BUNDLED_FIRST_PARTY_EXTENSION_PACKAGE_NAMES: readonly string[] = Object.freeze([]);',
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
    resolve(repoRoot, 'apps/cli/src/extensions/registry/sources/generatedBundledPlugins.ts'),
    'utf8',
  );
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_EXTENSION_PACKAGE_NAMES/);
  assert.match(cliOut, /@happier-dev\/extensions-claude/);
  assert.match(cliOut, /@happier-dev\/extensions-codex/);
  assert.ok(
    cliOut.indexOf('@happier-dev/extensions-claude') < cliOut.indexOf('@happier-dev/extensions-codex'),
    'expected lexical order',
  );

  const uiOut = readFileSync(
    resolve(repoRoot, 'apps/ui/sources/agents/registry/generatedBundledPluginEntries.ts'),
    'utf8',
  );
  assert.match(uiOut, /SOME_OTHER_EXPORT/);
  assert.match(uiOut, /@happier-dev\/extensions-claude/);

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
  assert.match(agentsOut, /"claude":\s*Object\.freeze\(/);
  assert.match(agentsOut, /"codex":\s*Object\.freeze\(/);
  assert.match(agentsOut, /"id":\s*"claude"/);
  assert.match(agentsOut, /"id":\s*"codex"/);
});
