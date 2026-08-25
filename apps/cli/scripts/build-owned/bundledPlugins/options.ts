import type { GeneratorMode } from './outputs.ts';

export type GeneratorScope = 'all' | 'projections';

export type GeneratorOptions = Readonly<{
  rootDir: string;
  mode: GeneratorMode;
  scope: GeneratorScope;
  workspaceNames: readonly string[];
  aggregateOnly: boolean;
}>;

export function shouldHoldGeneratorWorkspaceLockDuringGeneration(mode: GeneratorMode): boolean {
  return mode === 'write';
}

export function shouldEvaluateBundledRuntimeSource(scope: GeneratorScope): boolean {
  return scope === 'all';
}

export type PluginAuthorRuntimeLoadScope = 'none' | 'manifest' | 'full';

export function resolvePluginAuthorRuntimeLoadScope({
  aggregateOnly,
  scope,
}: Pick<GeneratorOptions, 'aggregateOnly' | 'scope'>): PluginAuthorRuntimeLoadScope {
  if (aggregateOnly) return 'none';
  return scope === 'projections' ? 'manifest' : 'full';
}

export function printGeneratorUsage(): void {
  console.log([
    'Usage: node --experimental-strip-types scripts/migrations/extensions/generateBundledPluginEntries.ts [--root DIR] [--mode write|check] [--scope all|projections] [--workspace plugins-<id>] [--aggregate]',
    '',
    'Generates/patches bundled plugin entry maps from packages/plugins/*.',
    '',
    '--scope projections (check only) compares the generated projections against the',
    'bundled plugin sources and the installed bundle bytes. --scope all (default) also',
    're-stages every bundled daemon runtime and requires the installed bytes to equal',
    'that fresh build, which is a whole-repo build-determinism question because the',
    'stage inlines the current plugin-sdk/protocol output into every bundle.',
  ].join('\n'));
}

export function parseGeneratorCliArgs(argv: readonly string[]): GeneratorOptions {
  let rootDir = process.cwd();
  let mode: GeneratorMode = 'write';
  let scope: GeneratorScope = 'all';
  let aggregateOnly = false;
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
      if (next !== 'all' && next !== 'projections') {
        throw new Error(`Invalid --scope (expected all|projections): ${String(next)}`);
      }
      scope = next;
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
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (aggregateOnly && workspaceNames.length > 0) {
    throw new Error('--aggregate cannot be combined with --workspace');
  }
  if (mode === 'write' && scope !== 'all') {
    throw new Error('--scope projections is a check-only scope; --mode write always publishes --scope all');
  }
  return { rootDir, mode, scope, workspaceNames: Object.freeze(workspaceNames), aggregateOnly };
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
