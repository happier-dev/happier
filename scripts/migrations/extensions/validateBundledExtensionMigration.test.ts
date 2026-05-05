import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectForbiddenBundledExtensionMigrationFindings } from './validateBundledExtensionMigration.ts';

test('validator fails on V1 manifest leftovers (pluginManifestV1.ts)', () => {
  const findings = collectForbiddenBundledExtensionMigrationFindings([
    {
      filePath: 'packages/protocol/src/plugins/pluginManifestV1.ts',
      content: 'export const PluginManifestV1Schema = {};\n',
    },
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
      content: 'export const bundledAgentDefinitions = Object.freeze({});\n',
    },
  ]);

  assert.deepEqual(findings, [
    {
      filePath: 'packages/protocol/src/plugins/pluginManifestV1.ts',
      pattern: 'packages/protocol/src/plugins/pluginManifestV1.ts',
      replacement: 'Delete V1 manifest; use packages/protocol/src/plugins/manifest/v2.ts',
    },
  ]);
});

test('validator fails on ui.ts leftovers in bundled extension topology', () => {
  const findings = collectForbiddenBundledExtensionMigrationFindings([
    {
      filePath: 'packages/plugins/acme/src/ui.ts',
      content: 'export const UI = {};\n',
    },
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
      content: 'export const bundledAgentDefinitions = Object.freeze({});\n',
    },
  ]);

  assert.deepEqual(findings, [
    {
      filePath: 'packages/plugins/acme/src/ui.ts',
      pattern: 'packages/plugins/<extensionId>/src/ui.ts',
      replacement: 'Use packages/plugins/<extensionId>/src/ui/index.ts (ui folder) instead',
    },
  ]);
});

test('validator ignores built_in|plugin architectural truth in allowlisted plugin substrate paths', () => {
  const findings = collectForbiddenBundledExtensionMigrationFindings([
    {
      filePath: 'apps/cli/src/plugins/registry/types.ts',
      content: "export type ResolvedContributionSource = 'built_in' | 'plugin';\n",
    },
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
      content: 'export const bundledAgentDefinitions = Object.freeze({});\n',
    },
  ]);

  assert.deepEqual(findings, []);
});

test('validator ignores built_in|plugin architectural truth in test files', () => {
  const findings = collectForbiddenBundledExtensionMigrationFindings([
    {
      filePath: 'apps/cli/src/plugins/registry/mergedRegistry.test.ts',
      content: "export const sourceKind = 'plugin';\nexport const legacy = 'built_in';\n",
    },
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
      content: 'export const bundledAgentDefinitions = Object.freeze({});\n',
    },
  ]);

  assert.deepEqual(findings, []);
});

test('validator still fails on built_in|plugin architectural truth outside allowlisted paths', () => {
  const findings = collectForbiddenBundledExtensionMigrationFindings([
    {
      filePath: 'packages/protocol/src/plugins/manifest/v2.ts',
      content: "export type ResolvedContributionSource = 'built_in' | 'plugin';\n",
    },
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
      content: 'export const bundledAgentDefinitions = Object.freeze({});\n',
    },
  ]);

  assert.deepEqual(findings, [
    {
      filePath: 'packages/protocol/src/plugins/manifest/v2.ts',
      pattern: "'built_in' | 'plugin'",
      replacement: "Replace built_in|plugin split with provenance ('first_party'|'external') + source.kind",
    },
  ]);
});

test('validator fails on dual-ownership for migrated families (non-bridge host-local code)', () => {
  const findings = collectForbiddenBundledExtensionMigrationFindings([
    {
      filePath: 'packages/plugins/acme/src/agent/definition.ts',
      content: 'export const AGENT_DEFINITION = Object.freeze({ id: \"acme\" });\n',
    },
    {
      filePath: 'apps/ui/sources/agents/providers/acme/core.ts',
      content: 'export const authored = 1;\n',
    },
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
      content: 'export const bundledAgentDefinitions = Object.freeze({});\n',
    },
  ]);

  assert.deepEqual(findings, [
    {
      filePath: 'apps/ui/sources/agents/providers/acme/core.ts',
      pattern: 'dual-ownership: apps/ui/sources/agents/providers/acme/**',
      replacement: 'Migrate authored ownership into packages/plugins/acme/**; host-local tree must be bridge-only or deleted',
    },
  ]);
});

test('dual-ownership check allows bridge-only host-local modules', () => {
  const findings = collectForbiddenBundledExtensionMigrationFindings([
    {
      filePath: 'packages/plugins/acme/src/agent/definition.ts',
      content: 'export const AGENT_DEFINITION = Object.freeze({ id: \"acme\" });\n',
    },
    {
      filePath: 'apps/ui/sources/agents/providers/acme/index.ts',
      content: "export * from '@happier-dev/plugins-acme/dist/agent/ui/index.js';\n",
    },
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
      content: 'export const bundledAgentDefinitions = Object.freeze({});\n',
    },
  ]);

  assert.deepEqual(findings, []);
});

test('validator fails when old generated bundledAgentDefinitionFamilies.ts exists', () => {
  const findings = collectForbiddenBundledExtensionMigrationFindings([
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
      content: 'export const bundledAgentDefinitions = Object.freeze({});\n',
    },
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitionFamilies.ts',
      content: 'export const BUNDLED_AGENT_DEFINITION_FAMILIES_BY_ID = {};\n',
    },
  ]);

  assert.deepEqual(findings, [
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitionFamilies.ts',
      pattern: 'BUNDLED_AGENT_DEFINITION_FAMILIES_BY_ID',
      replacement: 'Rename to BUNDLED_AGENT_DEFINITIONS_BY_ID',
    },
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitionFamilies.ts',
      pattern: 'packages/agents/src/generated/bundledAgentDefinitionFamilies.ts',
      replacement: 'Delete legacy generated file; use packages/agents/src/generated/bundledAgentDefinitions.ts',
    },
  ]);
});

test('validator fails when required identifiers are missing in bundledAgentDefinitions.ts', () => {
  const findings = collectForbiddenBundledExtensionMigrationFindings([
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
      content: 'export const BUNDLED_AGENT_DEFINITIONS_BY_ID = Object.freeze({});\n',
    },
  ]);

  assert.deepEqual(findings, [
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
      pattern: 'missing required export: bundledAgentDefinitions',
      replacement: 'Export bundledAgentDefinitions (and/or BUNDLED_AGENT_DEFINITIONS) from generated output',
    },
  ]);
});

test('validator fails on forbidden families identifiers', () => {
  const findings = collectForbiddenBundledExtensionMigrationFindings([
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
      content: 'export const bundledAgentDefinitions = Object.freeze({});\n',
    },
    {
      filePath: 'packages/plugins/acme/src/agent/definition.ts',
      content: 'export const AGENT_DEFINITION_FAMILY = Object.freeze({ id: \"acme\" });\n',
    },
  ]);

  assert.deepEqual(findings, [
    {
      filePath: 'packages/plugins/acme/src/agent/definition.ts',
      pattern: 'AGENT_DEFINITION_FAMILY',
      replacement: 'Rename to AGENT_DEFINITION',
    },
  ]);
});

test('validator fails on reintroduced bundledAgentDefinitionFamilies naming', () => {
  const findings = collectForbiddenBundledExtensionMigrationFindings([
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
      content: 'export const bundledAgentDefinitionFamilies = Object.freeze({});\n',
    },
  ]);

  assert.deepEqual(findings, [
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
      pattern: 'bundledAgentDefinitionFamilies',
      replacement: 'Rename to bundledAgentDefinitions',
    },
  ]);
});

test('validator fails when extension package imports host internals (@/ alias)', () => {
  const findings = collectForbiddenBundledExtensionMigrationFindings([
    {
      filePath: 'packages/plugins/acme/src/agent/runtime/createRuntime.ts',
      content: "import { logger } from '@/ui/logger';\n",
    },
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
      content: 'export const bundledAgentDefinitions = Object.freeze({});\n',
    },
  ]);

  assert.deepEqual(findings, [
    {
      filePath: 'packages/plugins/acme/src/agent/runtime/createRuntime.ts',
      pattern: "from '@/…'",
      replacement: 'Extension packages must not import host internals; use injected ExtensionContextV1 services instead',
    },
  ]);
});

test('validator enforces bundledAgentDefinitions export contract from filesystem when inventory omits generated file', () => {
  const originalCwd = process.cwd();
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-validator-'));
  try {
    process.chdir(rootDir);
    const generatedPath = join(rootDir, 'packages/agents/src/generated/bundledAgentDefinitions.ts');
    mkdirSync(join(rootDir, 'packages/agents/src/generated'), { recursive: true });
    writeFileSync(generatedPath, 'export const BUNDLED_AGENT_DEFINITIONS_BY_ID = Object.freeze({});\n', 'utf8');

    const findings = collectForbiddenBundledExtensionMigrationFindings([
      // Any packages file triggers generated-agent contract enforcement.
      {
        filePath: 'packages/protocol/src/plugins/manifest/v2.ts',
        content: 'export const whatever = 1;\n',
      },
    ]);

    assert.deepEqual(findings, [
      {
        filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
        pattern: 'missing required export: bundledAgentDefinitions',
        replacement: 'Export bundledAgentDefinitions (and/or BUNDLED_AGENT_DEFINITIONS) from generated output',
      },
    ]);
  } finally {
    process.chdir(originalCwd);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('validator fails when legacy bundledAgentDefinitionFamilies.ts exists on filesystem but is not in inventory', () => {
  const originalCwd = process.cwd();
  const rootDir = mkdtempSync(join(tmpdir(), 'happier-extension-validator-'));
  try {
    process.chdir(rootDir);
    mkdirSync(join(rootDir, 'packages/agents/src/generated'), { recursive: true });
    writeFileSync(
      join(rootDir, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
      'export const bundledAgentDefinitions = Object.freeze({});\n',
      'utf8',
    );
    writeFileSync(
      join(rootDir, 'packages/agents/src/generated/bundledAgentDefinitionFamilies.ts'),
      'export const BUNDLED_AGENT_DEFINITION_FAMILIES_BY_ID = Object.freeze({});\n',
      'utf8',
    );

    const findings = collectForbiddenBundledExtensionMigrationFindings([
      // Any packages file triggers generated-agent contract enforcement.
      {
        filePath: 'packages/protocol/src/plugins/manifest/v2.ts',
        content: 'export const whatever = 1;\n',
      },
    ]);

    assert.deepEqual(findings, [
      {
        filePath: 'packages/agents/src/generated/bundledAgentDefinitionFamilies.ts',
        pattern: 'packages/agents/src/generated/bundledAgentDefinitionFamilies.ts',
        replacement: 'Delete legacy generated file; use packages/agents/src/generated/bundledAgentDefinitions.ts',
      },
    ]);
  } finally {
    process.chdir(originalCwd);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('bundled migration validator does not require AGENT_DEFINITION token in generated aggregate file', () => {
  const findings = collectForbiddenBundledExtensionMigrationFindings([
    {
      filePath: 'packages/agents/src/generated/bundledAgentDefinitions.ts',
      content: [
        'export const bundledAgentDefinitions: Readonly<Record<string, unknown>> = Object.freeze({});',
        '',
      ].join('\n'),
    },
  ]);

  assert.equal(
    findings.some((f) => f.pattern.includes('missing required identifier: AGENT_DEFINITION')),
    false,
  );
});
