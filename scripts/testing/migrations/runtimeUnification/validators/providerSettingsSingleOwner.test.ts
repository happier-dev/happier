import assert from 'node:assert/strict';
import test from 'node:test';

import { validateProviderSettingsSingleOwner } from './providerSettingsSingleOwner.ts';

const VALID_FILES = Object.freeze([
  {
    path: 'packages/plugins/claude/src/manifest.ts',
    content: 'import { CLAUDE_PROVIDER_SETTINGS_CONTRIBUTION } from "./providerSettings/definition.js";\nexport const manifest = { contributes: { providerSettings: [CLAUDE_PROVIDER_SETTINGS_CONTRIBUTION] } };\n',
  },
  {
    path: 'packages/plugins/claude/src/providerSettings/definition.ts',
    content: 'import { defineProviderSettingsContribution, buildProviderSettingsDefaults, providerSettingsContributionToUiDescriptor } from "@happier-dev/plugin-sdk/manifest/providerSettings";\nexport const CLAUDE_PROVIDER_SETTINGS_CONTRIBUTION = defineProviderSettingsContribution({ id: "claude.providerSettings.v1", providerId: "claude", fields: [] });\nexport const CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS = buildProviderSettingsDefaults(CLAUDE_PROVIDER_SETTINGS_CONTRIBUTION);\nexport const CLAUDE_PROVIDER_SETTINGS_DESCRIPTOR = providerSettingsContributionToUiDescriptor(CLAUDE_PROVIDER_SETTINGS_CONTRIBUTION);\n',
  },
  {
    path: 'packages/plugins/claude/src/ui/settings/descriptor.ts',
    content: 'export { CLAUDE_PROVIDER_SETTINGS_DESCRIPTOR } from "../../providerSettings/definition.js";\n',
  },
  {
    path: 'packages/plugins/claude/src/protocol/remoteSettings.ts',
    content: 'import { CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS } from "../providerSettings/definition.js";\nexport { CLAUDE_REMOTE_PROVIDER_SETTINGS_DEFAULTS } from "../providerSettings/definition.js";\n',
  },
  {
    path: 'packages/agents/src/providerSettings/generated/bundledProviderSettings.ts',
    content: 'export const BUNDLED_PROVIDER_SETTINGS_CONTRIBUTIONS = [{ id: "claude.providerSettings.v1", providerId: "claude" }];\n',
  },
] as const);

const CODEX_VALID_FILES = Object.freeze([
  {
    path: 'packages/plugins/codex/src/manifest.ts',
    content: 'import { CODEX_PROVIDER_SETTINGS_CONTRIBUTION } from "./providerSettings/definition.js";\nexport const manifest = { contributes: { providerSettings: [CODEX_PROVIDER_SETTINGS_CONTRIBUTION] } };\n',
  },
  {
    path: 'packages/plugins/codex/src/providerSettings/definition.ts',
    content: 'import { defineProviderSettingsContribution, buildProviderSettingsDefaults, providerSettingsContributionToUiDescriptor } from "@happier-dev/plugin-sdk/manifest/providerSettings";\nexport const CODEX_PROVIDER_SETTINGS_CONTRIBUTION = defineProviderSettingsContribution({ id: "codex.providerSettings.v1", providerId: "codex", fields: [] });\nexport const CODEX_PROVIDER_SETTINGS_DEFAULTS = buildProviderSettingsDefaults(CODEX_PROVIDER_SETTINGS_CONTRIBUTION);\nexport const CODEX_PROVIDER_SETTINGS_DESCRIPTOR = providerSettingsContributionToUiDescriptor(CODEX_PROVIDER_SETTINGS_CONTRIBUTION);\n',
  },
] as const);

test('provider-settings single-owner validator accepts contribution-owned Claude settings', () => {
  const result = validateProviderSettingsSingleOwner({ files: VALID_FILES });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('provider-settings single-owner validator rejects hand-authored host field maps', () => {
  const files = [
    ...VALID_FILES,
    {
      path: 'packages/agents/src/providerSettings/registry.ts',
      content: 'const CLAUDE_REMOTE_PROVIDER_FIELDS = { enabled: { schema: z.boolean() } };\n',
    },
  ];

  const result = validateProviderSettingsSingleOwner({ files });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /forbidden duplicate provider-settings ownership pattern/);
});

test('provider-settings single-owner validator rejects provider-id branching in host projections', () => {
  const files = [
    ...VALID_FILES,
    {
      path: 'packages/agents/src/providerSettings/registry.ts',
      content: [
        'import { BUNDLED_PROVIDER_SETTINGS_CONTRIBUTIONS } from "./generated/bundledProviderSettings.js";',
        'export const contribution = BUNDLED_PROVIDER_SETTINGS_CONTRIBUTIONS.find((entry) => entry.providerId === "claude");',
        '',
      ].join('\n'),
    },
  ];

  const result = validateProviderSettingsSingleOwner({ files });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /provider-id branching/);
});

test('provider-settings single-owner validator rejects non-Claude contribution drift', () => {
  const files = [
    ...VALID_FILES,
    ...CODEX_VALID_FILES.map((file) => (
      file.path === 'packages/plugins/codex/src/providerSettings/definition.ts'
        ? { ...file, content: file.content.replaceAll('providerSettingsContributionToUiDescriptor', 'staleProviderSettingsDescriptorBuilder') }
        : file
    )),
  ];

  const result = validateProviderSettingsSingleOwner({ files });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /packages\/plugins\/codex\/src\/providerSettings\/definition\.ts/);
  assert.match(result.errors.join('\n'), /missing required single-owner evidence/);
});

test('provider-settings single-owner validator rejects hand-authored non-Claude provider setting definitions', () => {
  const files = [
    ...VALID_FILES,
    ...CODEX_VALID_FILES,
    {
      path: 'packages/plugins/codex/src/ui/settings.ts',
      content: [
        'export const CODEX_PROVIDER_SETTINGS_DESCRIPTOR = {',
        '  kind: "providerSettings.v1",',
        '  descriptorId: "codex.providerSettings.v1",',
        '  providerId: "codex",',
        '  settings: { codexBackendMode: { schema: { kind: "enum", values: ["acp"] }, default: "acp" } },',
        '};',
        '',
      ].join('\n'),
    },
  ];

  const result = validateProviderSettingsSingleOwner({ files });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /packages\/plugins\/codex\/src\/ui\/settings\.ts/);
  assert.match(result.errors.join('\n'), /hand-authored provider-settings definition/);
});

test('provider-settings single-owner validator rejects runtime-affecting UI descriptor leaves without contribution owner', () => {
  const files = [
    ...VALID_FILES,
    {
      path: 'packages/plugins/opencode/src/ui/descriptor.ts',
      content: [
        'export const OPENCODE_UI_DESCRIPTOR = {',
        '  settings: {',
        '    descriptorId: "opencode.providerSettings.v1",',
        '    uiSections: [{ id: "runtime", fields: [{ key: "opencodeBackendMode", kind: "enum" }] }],',
        '  },',
        '};',
        '',
      ].join('\n'),
    },
    {
      path: 'packages/plugins/opencode/src/agent/definition.ts',
      content: 'export const AGENT_DEFINITION = { id: "opencode", providerSettings: null };\n',
    },
    {
      path: 'packages/plugins/opencode/src/manifest.ts',
      content: 'export const PLUGIN_MANIFEST = { contributes: { backends: [] } };\n',
    },
  ];

  const result = validateProviderSettingsSingleOwner({ files });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /packages\/plugins\/opencode\/src\/ui\/descriptor\.ts/);
  assert.match(result.errors.join('\n'), /provider-settings descriptor has no canonical contribution owner/);
});

test('provider-settings single-owner validator rejects generated shared provider settings without plugin contribution owner', () => {
  const files = [
    ...VALID_FILES,
    {
      path: 'packages/agents/src/providerSettings/generated/bundledProviderSettings.ts',
      content: [
        'export const BUNDLED_PROVIDER_SETTINGS_CONTRIBUTIONS = [',
        '  { id: "claude.providerSettings.v1", providerId: "claude" },',
        '  { id: "opencode.providerSettings.v1", providerId: "opencode" },',
        '];',
        '',
      ].join('\n'),
    },
  ];

  const result = validateProviderSettingsSingleOwner({ files });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /packages\/agents\/src\/providerSettings\/generated\/bundledProviderSettings\.ts/);
  assert.match(result.errors.join('\n'), /opencode\.providerSettings\.v1/);
  assert.match(result.errors.join('\n'), /generated provider-settings projection has no canonical plugin contribution owner/);
});

test('provider-settings single-owner validator rejects per-provider host definition wrappers for all providers', () => {
  const files = [
    ...VALID_FILES.map((file) => (
      file.path === 'packages/agents/src/providerSettings/generated/bundledProviderSettings.ts'
        ? {
            ...file,
            content: 'export const BUNDLED_PROVIDER_SETTINGS_CONTRIBUTIONS = [{ id: "claude.providerSettings.v1", providerId: "claude" }, { id: "codex.providerSettings.v1", providerId: "codex" }];\n',
          }
        : file
    )),
    ...CODEX_VALID_FILES,
    {
      path: 'packages/agents/src/providerSettings/definitions/codexRemote.ts',
      content: [
        'import { BUNDLED_PROVIDER_SETTINGS_CONTRIBUTIONS } from "../generated/bundledProviderSettings.js";',
        'import { buildProviderSettingsDefinitionFromContribution } from "../fromContribution.js";',
        'function getCodexProviderSettingsContribution() { return BUNDLED_PROVIDER_SETTINGS_CONTRIBUTIONS[1]; }',
        'export const CODEX_REMOTE_PROVIDER_SETTINGS_DEFINITION = buildProviderSettingsDefinitionFromContribution(getCodexProviderSettingsContribution());',
        '',
      ].join('\n'),
    },
  ];

  const result = validateProviderSettingsSingleOwner({ files });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /packages\/agents\/src\/providerSettings\/definitions\/codexRemote\.ts/);
  assert.match(result.errors.join('\n'), /generated bundled provider-settings registry/);
});
