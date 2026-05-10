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

function pluginManifestSource(input: Readonly<{
  id: string;
  capabilities?: readonly string[];
  contributes?: string;
}>): string {
  return [
    'export const PLUGIN_MANIFEST = Object.freeze({',
    '  schemaVersion: 2,',
    `  id: ${JSON.stringify(input.id)},`,
    '  version: "0.0.0",',
    `  displayName: ${JSON.stringify(input.id)},`,
    '  description: "Test plugin manifest.",',
    '  engines: { happier: "^0.0.0" },',
    `  runtime: { apiVersion: 1, capabilities: ${JSON.stringify(input.capabilities ?? [])} },`,
    '  targets: {},',
    '  capabilities: { permissions: [] },',
    `  contributes: ${input.contributes ?? '{}'},`,
    '});',
    '',
  ].join('\n');
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
    pluginManifestSource({ id: 'happier.agent.claude', capabilities: ['agents'] }),
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
    pluginManifestSource({ id: 'happier.agent.codex', capabilities: ['agents'] }),
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
  assert.match(
    cliOut,
    /BUNDLED_FIRST_PARTY_ACTIVATION_TARGETS[\s\S]{0,220}provenance:\s*'first_party'/,
  );
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS/);
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

test('generateBundledPluginEntries rejects short bundled plugin owner ids', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-short-id-'));

  writeJson(resolve(repoRoot, 'packages/plugins/codex/package.json'), {
    name: '@happier-dev/plugins-codex',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/manifest.ts'),
    pluginManifestSource({ id: 'codex', capabilities: ['agents'] }),
    'utf8',
  );
  mkdirSync(resolve(repoRoot, 'packages/plugins/codex/src/agent'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/codex/src/agent/definition.ts'),
    'export const AGENT_DEFINITION = Object.freeze({ id: \"codex\" });\n',
    'utf8',
  );

  await assert.rejects(
    generateBundledPluginEntries(['--root', repoRoot, '--mode', 'write']),
    /canonical first-party plugin owner id/i,
  );
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
    pluginManifestSource({ id: 'happier.agent.claude', capabilities: ['agents'] }),
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
    pluginManifestSource({
      id: 'happier.scm.hosting.github',
      capabilities: ['scmHostingProviders'],
      contributes: '{ scmHostingProviders: [{ id: "github", kind: "github", displayName: "GitHub", baseUrl: "https://github.com" }] }',
    }),
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
  assert.match(cliOut, /"pluginId":\s*"happier\.scm\.hosting\.github"/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_SCM_HOSTING_PROVIDER_CONTRIBUTIONS/);
  assert.match(cliOut, /id:\s*"github"/);
  assert.match(cliOut, /definition:\s*Object\.freeze\(\{/);
  assert.match(cliOut, /"kind":\s*"github"/);
  assert.doesNotMatch(cliOut, /"agentId":\s*"scm-github"/);

  const agentsOut = readFileSync(
    resolve(repoRoot, 'packages/agents/src/generated/bundledAgentDefinitions.ts'),
    'utf8',
  );
  assert.doesNotMatch(agentsOut, /scm-github/);
});

test('generateBundledPluginEntries projects bundled SCM backend and installable contributions', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-scm-backend-'));

  writeJson(resolve(repoRoot, 'packages/plugins/scm-sapling/package.json'), {
    name: '@happier-dev/plugins-scm-sapling',
    version: '0.0.0',
  });

  mkdirSync(resolve(repoRoot, 'packages/plugins/scm-sapling/src'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, 'packages/plugins/scm-sapling/src/manifest.ts'),
    [
      'const supported = Object.freeze({ support: "supported" });',
      'const unsupported = Object.freeze({ support: "unsupported", reason: "not_implemented" });',
      'export const PLUGIN_MANIFEST = Object.freeze({',
      '  schemaVersion: 2,',
      '  id: "happier.scm.backend.sapling",',
      '  version: "0.0.0",',
      '  displayName: "Sapling SCM backend",',
      '  description: "Sapling SCM backend.",',
      '  engines: { happier: "^0.0.0" },',
      '  runtime: { apiVersion: 1, capabilities: ["scmBackends"] },',
      '  targets: {},',
      '  capabilities: { permissions: [] },',
      '  contributes: {',
      '    installables: [{',
      '      id: "sapling",',
      '      key: "sapling",',
      '      kind: "dep",',
      '      version: "1",',
      '      capabilityId: "dep.sapling",',
      '      display: { name: "Sapling" },',
      '      description: "Sapling source control CLI.",',
      '      source: { kind: "manual_only", setupUrl: "https://sapling-scm.com/docs/introduction/installation" },',
      '      binary: { commands: ["sl"], systemFirst: true, managedFallback: false },',
      '      defaultPolicy: { autoInstallWhenNeeded: false, autoUpdateMode: "notify" },',
      '      consent: { install: "required", update: "required" },',
      '    }],',
      '    scmBackends: [{',
      '      id: "sapling",',
      '      displayName: "Sapling",',
      '      description: "Sapling local source control backend.",',
      '      repoModes: [".sl", ".git"],',
      '      detection: { rootMarkers: [".sl"] },',
      '      installableDependencies: ["dep.sapling"],',
      '      tooling: { commands: [{ installableKey: "dep.sapling", command: "sl" }], systemFirst: true, managedFallback: false },',
      '      safetyConstraints: { mutatesWorkingTree: true, requiresUserConfirmationForDestructiveWrites: true },',
      '      capabilities: {',
      '        detection: { repository: supported, repoIdentity: supported, ignoredPath: supported, repoMode: supported, executable: supported },',
      '        read: { status: supported, diffFile: supported, diffCommit: supported, log: supported, branches: unsupported, stash: unsupported, defaultBranch: unsupported, hostingProvider: unsupported, pullRequestStatus: unsupported },',
      '        changeSet: { model: "working-copy", diffAreas: ["pending", "both"], include: unsupported, exclude: unsupported, discard: supported },',
      '        commit: { create: supported, pathSelection: supported, lineSelection: unsupported, backout: supported },',
      '        remote: { read: supported, add: unsupported, setUrl: unsupported, remove: unsupported, fetch: unsupported, pull: unsupported, push: unsupported, publish: unsupported },',
      '        branch: { list: unsupported, create: unsupported, checkout: unsupported, merge: unsupported, rebase: unsupported, operationControl: unsupported },',
      '        worktree: { create: unsupported, remove: unsupported, prune: unsupported, prepare: unsupported },',
      '        lifecycle: { init: unsupported, clone: unsupported, publish: unsupported, identityRediscovery: supported, removeIndexLock: unsupported },',
      '        hosting: { providerDetection: unsupported, repositoryPublishTargets: unsupported, repositoryPublish: unsupported, pullRequestRead: unsupported, pullRequestStatus: unsupported, pullRequestCreate: unsupported, pullRequestReuse: unsupported, pullRequestCheckout: unsupported, pullRequestPrepareWorktree: unsupported, pullRequestRunStacked: unsupported },',
      '        checkpoints: { capture: unsupported, aliasFinalize: unsupported, diff: unsupported, cleanup: unsupported, backup: unsupported, rollbackApply: unsupported },',
      '        workspaceIntegration: { inspectLocation: unsupported, checkoutMaterialization: unsupported, workspaceTransfer: unsupported, exportPortability: unsupported, portablePathClassification: unsupported },',
      '        tooling: { systemCliResolution: supported, managedCliResolution: unsupported, binarySafe: supported },',
      '        freshness: { observed: supported, expiry: supported },',
      '      },',
      '    }],',
      '  },',
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
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_SCM_BACKEND_CONTRIBUTIONS/);
  assert.match(cliOut, /BUNDLED_FIRST_PARTY_INSTALLABLE_CONTRIBUTIONS/);
  assert.match(cliOut, /pluginId:\s*"happier\.scm\.backend\.sapling"/);
  assert.match(cliOut, /id:\s*"sapling"/);
  assert.match(cliOut, /capabilityId":\s*"dep\.sapling"/);
  assert.match(cliOut, /autoInstallWhenNeeded":\s*false/);
});

test('generateBundledPluginEntries rejects malformed bundled SCM provider contributions', async () => {
  const repoRoot = mkdtempSync(resolve(tmpdir(), 'happy-ps-04-generate-invalid-scm-'));

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
      '  id: "happier.scm.hosting.github",',
      '  version: "0.0.0",',
      '  displayName: "GitHub SCM hosting provider",',
      '  description: "Detects GitHub remotes.",',
      '  engines: { happier: "^0.0.0" },',
      '  runtime: { apiVersion: 1, capabilities: ["scmHostingProviders"] },',
      '  targets: {},',
      '  capabilities: { permissions: [] },',
      '  contributes: { scmHostingProviders: [{ id: "scm.github", kind: "github", displayName: "GitHub", baseUrl: "not-a-url" }] },',
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
    /Invalid PLUGIN_MANIFEST/,
  );
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
    pluginManifestSource({ id: 'happier.agent.placeholder', capabilities: ['agents'] }),
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
    pluginManifestSource({ id: 'happier.agent.ohmypi', capabilities: ['agents'] }),
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
