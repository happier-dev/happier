import type { GeneratorMode } from './outputs.ts';

export type GeneratorScope = 'all' | 'projections';

export type GeneratorOptions = Readonly<{
  rootDir: string;
  mode: GeneratorMode;
  scope: GeneratorScope;
  workspaceNames: readonly string[];
  aggregateOnly: boolean;
  /**
   * Publish only installed artifacts and inventories owned by a prepared
   * one-way execution target. Source-synchronized projections stay read-only
   * so validation on that target cannot repair the inputs it is checking.
   */
  targetOwnedOnly: boolean;
  /**
   * Publish only the manifest-derived generated TypeScript *compiler inputs*.
   *
   * These outputs (`packages/agents/src/generated/agentIds.ts` and the Protocol
   * provider-id projection) are compiled by workspaces the full publication run
   * itself depends on, so they must be publishable before any workspace `dist`
   * exists. This mode therefore reads only committed plugin manifest artifacts
   * plus the Protocol/Agents runtime, and never loads the plugin authoring
   * runtime, stages a daemon bundle with esbuild, or touches any other emitted
   * artifact.
   */
  compilerInputsOnly: boolean;
  /** Publish source Agent definition facts without compiling/staging executable runtimes. */
  agentDefinitionsOnly: boolean;
  /** Derive or check only declarations consumed by readCliSourceEntries. */
  daemonProjectionsOnly?: boolean;
  /** Private source-runtime output; never publishes into the checkout. */
  daemonOutputRoot?: string;
  inheritedFailuresStdin: boolean;
  /** Npm publication explicitly prepares installed runtime/package bytes. */
  packageArtifacts?: boolean;
}>;

export function shouldEvaluateBundledRuntimeSource(scope: GeneratorScope): boolean {
  return scope === 'all';
}

export type PluginAuthorRuntimeLoadScope = 'none' | 'manifest' | 'full';

export function resolvePluginAuthorRuntimeLoadScope({
  aggregateOnly,
  compilerInputsOnly,
  agentDefinitionsOnly,
  scope,
}: Pick<GeneratorOptions, 'aggregateOnly' | 'scope'> & Partial<Pick<GeneratorOptions, 'compilerInputsOnly' | 'agentDefinitionsOnly'>>): PluginAuthorRuntimeLoadScope {
  // Compiler-input publication reads committed manifest artifacts only. Loading
  // the authoring runtime would import the very `plugin-sdk`/`cli-common`
  // output this mode exists to unblock.
  if (aggregateOnly || compilerInputsOnly || agentDefinitionsOnly) return 'none';
  return scope === 'projections' ? 'manifest' : 'full';
}

export function printGeneratorUsage(): void {
  console.log([
    'Usage: node --conditions=happier-source --experimental-strip-types apps/cli/scripts/build-owned/generateBundledPluginEntries.ts [--root DIR] [--mode write|check] [--scope projections] [--daemon-projections] [--daemon-output-root DIR] [--workspace plugins-<id>] [--target-owned-only] [--aggregate] [--compiler-inputs] [--agent-definitions] [--package-artifacts]',
    '',
    'Generates/patches bundled plugin entry maps from packages/plugins/*.',
    '',
    '--compiler-inputs publishes only the manifest-derived generated TypeScript compiler',
    'inputs (bundled Agent ids/identities and the Protocol provider-id projection) from the',
    'committed plugin manifest artifacts. It is the pre-build step the shared-dependency',
    'build owner runs before compiling the workspaces that consume those inputs.',
    '',
    '--agent-definitions refreshes authored Agent definition facts through the same',
    'projection writer, deriving native-home keys from static Agent source. It does not',
    'prepare workspace dist or stage executable Plugin bundles.',
    '',
    '--scope projections is the optional explicit spelling for check mode. The retired',
    'whole-runtime determinism scope is not a public generator mode; writes always publish',
    'the current complete source-owned output set unless --compiler-inputs or',
    '--agent-definitions selects its bounded source preparation phase.',
    '',
    '--package-artifacts additionally prepares the installed plugin manifests and runtime',
    'bytes for npm publication, limited to selected workspaces when scoped. Scoped writes',
    'validate selected source against published peers; checks and unscoped writes read all source.',
    '',
    '--daemon-projections checks only the daemon source entry locator table and manifest',
    'assets, including runner factories derived from authored registration. It requires',
    '--mode check and cannot be combined with other preparation selectors.',
    '--daemon-output-root DIR derives those same projections into a private output root',
    'with --daemon-projections --mode write, plus each package\'s serialized',
    '.happier-plugin/plugin.json under packages/plugins/<id>; checkout outputs stay read-only.',
  ].join('\n'));
}

export function parseGeneratorCliArgs(argv: readonly string[]): GeneratorOptions {
  let rootDir = process.cwd();
  let mode: GeneratorMode = 'write';
  let requestedScope: GeneratorScope | undefined;
  let aggregateOnly = false;
  let compilerInputsOnly = false;
  let agentDefinitionsOnly = false;
  let daemonProjectionsOnly = false;
  let daemonOutputRoot: string | undefined;
  let targetOwnedOnly = false;
  let packageArtifacts = false;
  let inheritedFailuresStdin = false;
  const workspaceNames: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printGeneratorUsage();
      process.exit(0);
    }
    if (arg === '--root') {
      const next = argv[index + 1];
      if (!next) throw new Error('Missing value for --root');
      rootDir = next;
      index += 1;
      continue;
    }
    if (arg === '--mode') {
      const next = argv[index + 1];
      if (next !== 'write' && next !== 'check') {
        throw new Error(`Invalid --mode (expected write|check): ${String(next)}`);
      }
      mode = next;
      index += 1;
      continue;
    }
    if (arg === '--scope') {
      const next = argv[index + 1];
      if (next !== 'projections') {
        throw new Error(`Invalid --scope (expected projections): ${String(next)}`);
      }
      requestedScope = next;
      index += 1;
      continue;
    }
    if (arg === '--workspace') {
      const next = argv[index + 1];
      if (!next || next.trim().length === 0) throw new Error('Missing value for --workspace');
      const workspaceName = next.startsWith('@happier-dev/')
        ? next.slice('@happier-dev/'.length)
        : next;
      if (!workspaceName.startsWith('plugins-')) {
        throw new Error(`Invalid --workspace '${next}': expected a plugins-* workspace`);
      }
      if (!workspaceNames.includes(workspaceName)) workspaceNames.push(workspaceName);
      index += 1;
      continue;
    }
    if (arg === '--aggregate') {
      aggregateOnly = true;
      continue;
    }
    if (arg === '--compiler-inputs') {
      compilerInputsOnly = true;
      continue;
    }
    if (arg === '--agent-definitions') {
      agentDefinitionsOnly = true;
      continue;
    }
    if (arg === '--daemon-projections') {
      daemonProjectionsOnly = true;
      continue;
    }
    if (arg === '--daemon-output-root') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error('Missing value for --daemon-output-root');
      daemonOutputRoot = next;
      index += 1;
      continue;
    }
    if (arg === '--target-owned-only') {
      targetOwnedOnly = true;
      continue;
    }
    if (arg === '--package-artifacts') {
      packageArtifacts = true;
      continue;
    }
    if (arg === '--inherited-failures-stdin') {
      inheritedFailuresStdin = true;
      continue;
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (daemonOutputRoot && (!daemonProjectionsOnly || mode !== 'write' || requestedScope)) {
    throw new Error('--daemon-output-root requires --daemon-projections --mode write without --scope');
  }
  if (daemonProjectionsOnly && ((mode !== 'check' && !daemonOutputRoot) || aggregateOnly || compilerInputsOnly
    || agentDefinitionsOnly || workspaceNames.length > 0 || packageArtifacts || inheritedFailuresStdin)) {
    throw new Error('--daemon-projections requires an unscoped --mode check without other preparation selectors');
  }
  if (aggregateOnly && workspaceNames.length > 0) {
    throw new Error('--aggregate cannot be combined with --workspace');
  }
  if (compilerInputsOnly && (aggregateOnly || workspaceNames.length > 0)) {
    throw new Error('--compiler-inputs cannot be combined with --aggregate or --workspace');
  }
  if (agentDefinitionsOnly && (aggregateOnly || compilerInputsOnly || workspaceNames.length > 0 || targetOwnedOnly)) {
    throw new Error('--agent-definitions cannot be combined with --aggregate, --compiler-inputs, --workspace or --target-owned-only');
  }
  if (targetOwnedOnly && mode !== 'write') {
    throw new Error('--target-owned-only requires --mode write');
  }
  if (targetOwnedOnly && workspaceNames.length === 0) {
    throw new Error('--target-owned-only requires at least one --workspace selector');
  }
  if (targetOwnedOnly && (aggregateOnly || compilerInputsOnly)) {
    throw new Error('--target-owned-only cannot be combined with --aggregate or --compiler-inputs');
  }
  if (packageArtifacts && requestedScope === 'projections') {
    throw new Error('--package-artifacts cannot be combined with --scope projections');
  }
  if (mode === 'write' && requestedScope === 'projections') {
    throw new Error('--scope projections is a check-only scope; write mode always publishes the complete output set');
  }
  const scope: GeneratorScope = daemonProjectionsOnly || (mode === 'check' && !packageArtifacts) ? 'projections' : 'all';
  return {
    rootDir,
    mode,
    scope,
    workspaceNames: Object.freeze(workspaceNames),
    aggregateOnly,
    compilerInputsOnly,
    agentDefinitionsOnly,
    ...(daemonProjectionsOnly ? { daemonProjectionsOnly: true } : {}),
    ...(daemonOutputRoot ? { daemonOutputRoot } : {}),
    inheritedFailuresStdin,
    targetOwnedOnly,
    ...(packageArtifacts ? { packageArtifacts: true } : {}),
  };
}

export function resolveSelectedBundledPluginPackageNames(
  bundledPluginPackageNames: readonly string[],
  workspaceNames: readonly string[],
): readonly string[] {
  const bundledPackageNames = new Set(bundledPluginPackageNames);
  return Object.freeze(workspaceNames.map((workspaceName) => {
    const packageName = `@happier-dev/${workspaceName}`;
    if (!bundledPackageNames.has(packageName)) {
      throw new Error(`Requested bundled plugin workspace is not published by this checkout: ${workspaceName}`);
    }
    return packageName;
  }));
}

/** An all-plugin canonical write is the unscoped publication, including native facts. */
export function normalizeCanonicalGeneratorPublication(
  argv: readonly string[],
  options: GeneratorOptions,
  bundledWorkspaceNames: readonly string[],
): Readonly<{ argv: readonly string[]; options: GeneratorOptions }> {
  const selectsAll = options.workspaceNames.length > 0
    && options.workspaceNames.length === bundledWorkspaceNames.length
    && bundledWorkspaceNames.every((name) => options.workspaceNames.includes(name));
  if (!selectsAll || options.mode !== 'write' || options.targetOwnedOnly) return { argv, options };
  return {
    options: { ...options, workspaceNames: [] },
    argv: argv.filter((arg, index) => arg !== '--workspace' && argv[index - 1] !== '--workspace'),
  };
}
