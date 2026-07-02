import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Mode = 'write' | 'check';

type TemplateFile = Readonly<{ relativePath: string; content: string }>;

function printUsage(): void {
  console.log([
    'Usage: node --experimental-strip-types scripts/migrations/plugins/bootstrapExtensionPackage.ts <extensionId> [--root DIR] [--mode write|check]',
    '',
    'Scaffolds a new first-party bundled extension package under `packages/plugins/<extensionId>` from `packages/plugins/_template`.',
  ].join('\n'));
}

function parseCliArgs(argv: readonly string[]): Readonly<{ extensionId: string; rootDir: string; mode: Mode }> {
  const positional: string[] = [];
  let rootDir = process.cwd();
  let mode: Mode = 'write';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printUsage();
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
    if (arg.startsWith('-')) {
      throw new Error(`Unknown arg: ${arg}`);
    }
    positional.push(arg);
  }

  const extensionId = positional[0];
  if (!extensionId) {
    throw new Error('Missing required <extensionId>');
  }

  return { extensionId, rootDir, mode };
}

function walkTemplateFiles(templateRoot: string, relativeDir = ''): TemplateFile[] {
  const absDir = resolve(templateRoot, relativeDir);
  const out: TemplateFile[] = [];

  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const relPath = relativeDir ? join(relativeDir, entry.name) : entry.name;
    const absPath = resolve(templateRoot, relPath);
    if (entry.isDirectory()) {
      out.push(...walkTemplateFiles(templateRoot, relPath));
      continue;
    }
    if (!entry.isFile()) continue;
    out.push({ relativePath: relPath, content: readFileSync(absPath, 'utf8') });
  }

  return out;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeFileAtomic(path: string, content: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, content, 'utf8');
}

function replacePlaceholders(content: string, params: Readonly<{ extensionId: string }>): string {
  return content.replaceAll('__extensionId__', params.extensionId);
}

async function loadCanonicalAgentIds(repoRoot: string): Promise<readonly string[]> {
  const agentTypesPath = resolve(repoRoot, 'packages/agents/src/types.ts');
  const mod = await import(pathToFileURL(agentTypesPath).href) as { CANONICAL_AGENT_IDS?: unknown };
  const ids = mod.CANONICAL_AGENT_IDS;
  if (!Array.isArray(ids) || !ids.every((value) => typeof value === 'string')) {
    throw new Error(`Invalid CANONICAL_AGENT_IDS export in ${agentTypesPath}`);
  }
  return ids;
}

function validateExtensionId(params: Readonly<{ extensionId: string; canonicalAgentIds: readonly string[] }>): void {
  if (!params.canonicalAgentIds.includes(params.extensionId)) {
    throw new Error([
      `Unsupported extensionId: ${params.extensionId}`,
      'This bootstrapper currently targets bundled agent extensions and requires <extensionId> to be a canonical AgentId.',
      'If you are creating a non-agent extension package, extend the bootstrapper to support that topology explicitly.',
    ].join('\n'));
  }
}

function ensureMinimalTopology(root: string): void {
  const requiredDirs = [
    'src',
    'src/ui',
    'src/agent',
    'src/hooks',
    'src/actions',
    'src/tools',
    'src/commands',
    'src/resources',
    'src/shared',
    'src/protocol',
  ];

  for (const rel of requiredDirs) {
    ensureDir(resolve(root, rel));
  }
}

function ensureEntryFile(path: string, content: string): void {
  if (statSync(path, { throwIfNoEntry: false })) {
    return;
  }
  writeFileAtomic(path, content);
}

function ensureScaffoldSourceFiles(extensionRoot: string, extensionId: string): void {
  ensureMinimalTopology(extensionRoot);

  ensureEntryFile(
    resolve(extensionRoot, 'src/index.ts'),
    [
      "export * from './manifest.js';",
      "export * from './activate.js';",
      "export * from './cli.js';",
      "export * from './ui/index.js';",
      "export * from './agent/index.js';",
      '',
    ].join('\n'),
  );

  ensureEntryFile(
    resolve(extensionRoot, 'src/manifest.ts'),
    [
      "import type { ExtensionManifestV2 } from '@happier-dev/protocol';",
      '',
      '// Thin composition file that declares this extension’s canonical manifest.',
      '// Keep this mostly declarative; executable behavior lives in domain folders.',
      'export const EXTENSION_MANIFEST: ExtensionManifestV2 = Object.freeze({',
      '  schemaVersion: 2,',
      `  id: ${JSON.stringify(extensionId)},`,
      '  version: \'0.0.0\',',
      `  displayName: ${JSON.stringify(extensionId)},`,
      '  description: undefined,',
      '  engines: Object.freeze({ happier: \'^0.0.0\' }),',
      '  runtime: Object.freeze({ apiVersion: 1, capabilities: Object.freeze([]) }),',
      '  targets: Object.freeze({}),',
      '  permissions: Object.freeze([]),',
      '  contributions: Object.freeze([]),',
      '});',
      '',
    ].join('\n'),
  );

  ensureEntryFile(
    resolve(extensionRoot, 'src/activate.ts'),
    [
      'export function activate(): void {',
      '  // Extension activation hook (optional).',
      '}',
      '',
    ].join('\n'),
  );

  ensureEntryFile(
    resolve(extensionRoot, 'src/cli.ts'),
    [
      'export const cli = Object.freeze({});',
      '',
    ].join('\n'),
  );

  ensureEntryFile(
    resolve(extensionRoot, 'src/ui/index.ts'),
    [
      'export const ui = Object.freeze({});',
      '',
    ].join('\n'),
  );

  ensureEntryFile(
    resolve(extensionRoot, 'src/agent/index.ts'),
    [
      "export * from './definition.js';",
      '',
    ].join('\n'),
  );

  ensureEntryFile(
    resolve(extensionRoot, 'src/agent/definition.ts'),
    [
      "import type { AgentDefinition } from '@happier-dev/agents';",
      '',
      '// IMPORTANT: this must stay JSON-serializable (data-only).',
      'export const AGENT_DEFINITION: AgentDefinition = Object.freeze({',
      `  id: ${JSON.stringify(extensionId)},`,
      '  core: {',
      `    id: ${JSON.stringify(extensionId)},`,
      `    cliSubcommand: ${JSON.stringify(extensionId)},`,
      `    detectKey: ${JSON.stringify(extensionId)},`,
      "    resume: { vendorResume: 'unsupported', vendorResumeIdField: null },",
      '    sessionStorage: { direct: false, persisted: false },',
      '    sessionCapabilities: {',
      "      sessionListing: 'unsupported',",
      "      sessionFork: { conversation: 'unsupported', fromMessage: 'unsupported' },",
      "      sessionRollback: { conversation: 'unsupported' },",
      '    },',
      "    handoff: { vendorStateTransfer: 'unsupported' },",
      "    tools: { delivery: 'unsupported', support: 'unsupported' },",
      '  },',
      "  sessionModeDescriptor: { source: 'none', semantics: 'none', runtimeSwitch: 'none' },",
      "  sessionModesKind: 'none',",
      "  modelConfig: { supportsSelection: false, nonAcpApplyScope: 'spawn_only', defaultMode: 'default', allowedModes: ['default'] },",
      "  authProbeConfig: { agentId: " + JSON.stringify(extensionId) + ", binaryNames: [" + JSON.stringify(extensionId) + "], statusCommand: null, parser: 'unknown', backgroundChecks: 'safe' },",
      "  localCli: { agentId: " + JSON.stringify(extensionId) + ", detectKey: " + JSON.stringify(extensionId) + ", machineLoginKey: " + JSON.stringify(extensionId) + ", supportKind: 'unsupported', loginLaunch: null },",
      `  agentCliRuntime: { id: ${JSON.stringify(extensionId)}, title: ${JSON.stringify(`${extensionId} CLI`)}, binaryName: ${JSON.stringify(extensionId)}, sourcePreferenceDefault: 'system-first', managedInstall: null, manualInstallKind: 'none', manualInstallRecipes: null, acceptsJavaScriptFileOverride: false },`,
      '  providerSettings: null,',
      '});',
      '',
    ].join('\n'),
  );
}

function renderPackageJson(templateJson: any, extensionId: string): any {
  const expectedName = `@happier-dev/plugins-${extensionId}`;
  return {
    ...templateJson,
    name: expectedName,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  const canonicalAgentIds = await loadCanonicalAgentIds(options.rootDir);
  validateExtensionId({ extensionId: options.extensionId, canonicalAgentIds });

  const templateRoot = resolve(options.rootDir, 'packages/plugins/_template');
  const extensionRoot = resolve(options.rootDir, 'packages/plugins', options.extensionId);

  if (statSync(extensionRoot, { throwIfNoEntry: false })) {
    throw new Error(`Extension package already exists: ${extensionRoot}`);
  }

  const files = walkTemplateFiles(templateRoot);
  const rendered = files.map((file) => ({
    relativePath: file.relativePath,
    content: replacePlaceholders(file.content, { extensionId: options.extensionId }),
  }));

  // Ensure the template has a package.json we can materialize.
  const templatePkg = rendered.find((f) => f.relativePath === 'package.json');
  if (!templatePkg) {
    throw new Error(`Missing template package.json at ${resolve(templateRoot, 'package.json')}`);
  }

  const pkgJson = renderPackageJson(JSON.parse(templatePkg.content), options.extensionId);
  const pkgJsonText = `${JSON.stringify(pkgJson, null, 2)}\n`;

  if (options.mode === 'check') {
    throw new Error('check mode is not supported for bootstrap yet');
  }

  // Write template-derived files (with placeholder replacements).
  for (const file of rendered) {
    if (file.relativePath === 'package.json') {
      writeFileAtomic(resolve(extensionRoot, 'package.json'), pkgJsonText);
      continue;
    }
    writeFileAtomic(resolve(extensionRoot, file.relativePath), file.content);
  }

  // Ensure required topology files exist even if template is minimal.
  ensureScaffoldSourceFiles(extensionRoot, options.extensionId);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
