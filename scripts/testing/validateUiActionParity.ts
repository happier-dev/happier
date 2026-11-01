import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AGENT_ACTION_EXCLUSION_REASONS, listActionSpecs, listActionCliCommandDeclarations } from '../../packages/protocol/src/actions/actionSpecs.ts';
import { listActionSpecsForCatalogSurface } from '../../packages/protocol/src/actions/actionCatalog.ts';
import { BUILT_IN_SETTINGS_DECLARATIONS_V1, buildBuiltInAccountSettingMutationV1,
  readPortablePlatformAccountSettingBindingV1, resolveBuiltInAccountSettingResetValueV1 } from '../../packages/protocol/src/actions/settings/settingsDeclarations.ts';
import { accountSettingsParse } from '../../packages/protocol/src/account/settings/accountSettings.ts';
import { collectUiActionParity, readUiActionParitySources } from './lib/uiActionParity.ts';

// Development diagnostic for the same source walker consumed by the UI parity test.
export function readCurrentUiActionParity() {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const files = readUiActionParitySources(root);
  const specs = listActionSpecs();
  const defaults = accountSettingsParse({});
  const settingBindings = new Map<string, string[]>();
  for (const declaration of BUILT_IN_SETTINGS_DECLARATIONS_V1) {
    if (declaration.storage?.scope !== 'account' || declaration.storage.access !== 'read_write') continue;
    // Ask the real pure semantic owner for an admitted reset delta; no write or service runs.
    const reset = resolveBuiltInAccountSettingResetValueV1(declaration);
    const delta = reset.success ? buildBuiltInAccountSettingMutationV1(declaration, defaults, reset.value) : null;
    for (const key of Object.keys(delta ?? {})) {
      const anchors = settingBindings.get(`account:${key}`) ?? [];
      anchors.push(declaration.anchor);
      settingBindings.set(`account:${key}`, anchors);
    }
    // The semantic Enter-to-send row binds a different canonical key per host.
    // Read both owners; an arbitrary metadata option never authorizes a write.
    for (const platform of ['web', 'native'] as const) {
      const binding = readPortablePlatformAccountSettingBindingV1(declaration, platform);
      if (!binding || binding.access !== 'read_write') continue;
      const anchors = settingBindings.get(`account:${binding.key}`) ?? [];
      anchors.push(declaration.anchor);
      settingBindings.set(`account:${binding.key}`, anchors);
    }
  }
  return { sourceFiles: files.length, canonicalSpecs: specs.length,
    ...collectUiActionParity(files, specs, BUILT_IN_SETTINGS_DECLARATIONS_V1, {
      sourceRoot: root,
      agentIds: new Set(listActionSpecsForCatalogSurface({ surface: 'agent' }).map(spec => spec.id)),
      mcpIds: new Set(listActionSpecsForCatalogSurface({ surface: 'mcp' }).map(spec => spec.id)),
      cliIds: new Set(listActionSpecsForCatalogSurface({ surface: 'cli' }).map(spec => spec.id)),
      cliCommandIds: new Set(listActionCliCommandDeclarations().map(({ spec }) => spec.id)),
      agentExclusionReasons: new Map(Object.entries(AGENT_ACTION_EXCLUSION_REASONS)),
      settingBindings,
    }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = readCurrentUiActionParity();
  console.log(`UI Action parity: ${report.sourceFiles} source files, ${report.canonicalSpecs} canonical specs, `
    + `${report.actions.length} Action sites, ${report.settings.length} settings sites, ${report.findings.length} findings`);
  console.log(JSON.stringify(report));
  if (report.findings.length || !report.actions.length || !report.settings.length) process.exitCode = 1;
}
