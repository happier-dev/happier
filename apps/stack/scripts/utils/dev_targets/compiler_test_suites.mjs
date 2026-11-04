import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { resolveVitestForwardArgs } from '../../../../../scripts/testing/vitestForwardArgs.mjs';

// Evidence-backed compiler consumers shared by both command dispatchers.
export const COMPILER_NATIVE_TEST_FILES = Object.freeze([
    'packages/plugin-sdk/scripts/apiSurfaceCli.test.mjs',
    'packages/plugin-sdk/scripts/apiSurface.test.mjs',
    'scripts/workspaces/firstPartyDeclarationIdentity.test.mjs',
    'scripts/workspaces/buildTypeScriptPackageDist.test.mjs',
    'scripts/workspaces/resolveTypeScriptCliInvocation.test.mjs',
    'scripts/workspaces/typecheckTouched.test.mjs',
    'scripts/workspaces/deriveTypecheckProjects.test.mjs',
    'scripts/workspaces/workspaceOutputScriptArgs.test.mjs',
    'scripts/workspaces/ensureWorkspacePackagesBuilt.test.mjs',
    'scripts/codemods/zod-mini/index.test.mjs',
    'scripts/codemods/zod-mini/transformContexts.test.mjs',
    'apps/ui/scripts/generateBundledPluginUiArtifacts.test.mjs',
    'packages/plugin-sdk/scripts/publicDeclarationReport.test.mjs',
    'packages/plugin-sdk/scripts/generateActionTypeMap.test.mjs',
    'packages/plugin-sdk/scripts/generateActionTypeMap.placement.test.mjs',
    'packages/plugin-sdk/scripts/projectCatalogMetadata.test.mjs',
    'packages/sdk/scripts/generateActions.test.mjs',
  ]);

const cliIntegrationCompilerFiles = ['src/plugins/scaffold/scaffold.integration.test.ts'];

export const COMPILER_TEST_SUITES = Object.freeze([
    { component: 'packages/plugin-sdk', configs: ['vitest.config.ts', 'vitest.source.config.ts', 'vitest.external-fixture.config.ts', 'vitest.facade-current.config.ts'], compilerFiles: [
      'src/settings/projections.test.ts', 'src/declarationClosureIdentity.test.ts',
      'src/featureProtocolPackagePolicy.test.ts', 'src/providers/projections.test.ts',
      'src/agentRuntime/projections.test.ts', 'src/registration/staticRegistrationSnapshots.contract.test.ts',
      'src/index.settings.test.ts', 'src/definePlugin.externalFixture.test.ts',
      'src/publicDeclarations.externalFixture.test.ts',
      'src/testing/uiHost.test.ts', 'src/mcp/projections.test.ts',
      'src/coreDomainProjections.test.ts', 'src/scm/projections.test.ts',
      'src/normalSurfaceContract.test.ts', 'src/connected-accounts/projections.test.ts',
      'src/voice/projections.test.ts', 'src/examples/publicAuthoringExamples.test.ts',
      'src/mcpResourcesSourceProjection.test.ts',
    ] },
    { component: 'packages/plugin-sdk', configs: ['vitest.declaration-closure.config.ts'], compilerFiles: ['src/declarationClosureIdentity.test.ts'] },
    { component: 'packages/protocol', configs: ['vitest.config.ts', '../../vitest.config.ts'], compilerFiles: [
      'src/voice/realtime/agentSession.test.ts', 'src/plugins/availability/declarationFootprint.test.ts',
      'src/browser/automation/locators.test.ts', 'src/plugins/contributions/ui/destinationBindings.test.ts',
    ] },
    { component: 'packages/cli-common', configs: ['vitest.config.ts'], compilerFiles: ['src/componentArtifacts/finalizeRuntimeArtifactPayload.test.ts'] },
    { component: 'packages/channels-protocol', configs: ['vitest.config.ts'], compilerFiles: ['src/sdkSchemaClosure.test.ts'] },
    { component: 'packages/triage-protocol', configs: ['vitest.config.ts'], compilerSetup: true, compilerFiles: ['src/sdkSchemaClosure.test.ts'] },
    { component: 'apps/ui', configs: ['vitest.config.ts'], compilerFiles: [
      'sources/text/declarationEmission.test.ts', 'sources/components/settings/embeds/snippets.test.ts',
    ] },
    { component: 'apps/cli', configs: ['vitest.config.ts', 'vitest.inMemory.config.ts'], compilerFiles: [
      'scripts/build.test.ts', 'scripts/build-owned/bundledPlugins/agentUi.test.ts',
      'scripts/build-owned/generateBundledPluginEntries.test.ts',
    ] },
    { component: 'apps/cli', configs: ['vitest.source.integration.config.ts'], compilerFiles: cliIntegrationCompilerFiles },
    { component: 'apps/cli', configs: ['vitest.integration.config.ts'], compilerSetup: true, compilerFiles: cliIntegrationCompilerFiles },
  ].map(suite => Object.freeze({ ...suite, configs: Object.freeze(suite.configs), compilerFiles: Object.freeze(suite.compilerFiles) })));

const requireVitest = createRequire(new URL('../../../../../apps/ui/package.json', import.meta.url));
// Load the package's ESM entry as ESM. The source-runtime loader must not
// reinterpret Vitest's import-only dependencies through CommonJS require.
const { parseCLI } = await import(requireVitest.resolve('vitest/node'));
export function refineCompilerSuiteSelection(policy, facts, repoRoot, skipCompilerSetup = false) {
  if (policy.compilerSuite !== '1' || facts.admissionWrapper === '1') return;
  const suite = COMPILER_TEST_SUITES.find(candidate =>
    candidate.component === facts.component && candidate.configs.includes(facts.config));
  if (!suite || (suite.compilerSetup && !skipCompilerSetup)) return;
  const filters = readVitestFileFilters(facts);
  if (!filters.length) return;
  const packageRoot = posix.join(repoRoot.replaceAll('\\', '/'), suite.component);
  const selectedCompiler = suite.compilerFiles.some(file => {
    const path = `${packageRoot}/${file}`;
    return filters.some(value => {
      const absolute = /^(?:\/|[a-z]:\/)/iu.test(value);
      if (absolute && path.startsWith(value)) return true;
      const relativeFilter = posix.relative(packageRoot, absolute ? value : posix.join(packageRoot, value))
        + (value.endsWith('/') ? '/' : '');
      return file.toLocaleLowerCase().includes(value.toLocaleLowerCase())
        || file.toLocaleLowerCase().includes(relativeFilter.toLocaleLowerCase());
    });
  });
  if (!selectedCompiler) {
    policy.heavyClass = 'validation';
    policy.localCompile = '0';
  }
}

export function readVitestFileFilters(facts) {
  let args = facts.vitestArguments;
  if (facts.entry === 'runVitestShards.mjs' && facts.component === 'apps/cli') {
    args = resolveVitestForwardArgs(['node', facts.entry, ...args]);
  }
  if (!args.length) return [];
  // Vitest owns option parsing: option values are never file selections.
  try {
    const { filter } = parseCLI(['vitest', ...(args[0] === 'run' ? args : ['run', ...args])]);
    return filter.map(value => String(value).replaceAll('\\', '/').replace(/:\d+(?::\d+)?$/u, ''));
  } catch {
    // Failed inspection cannot earn a smaller reservation. Let Vitest report
    // invalid options when the actual command runs.
    return [];
  }
}
