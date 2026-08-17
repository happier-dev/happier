import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Mode = 'write' | 'check';

type TemplateFile = Readonly<{ relativePath: string; content: string }>;

function printUsage(): void {
  console.log([
    'Usage: node --experimental-strip-types scripts/migrations/extensions/bootstrapExtensionPackage.ts <extensionId> [--root DIR] [--mode write|check]',
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
  return content
    .replaceAll('__pluginId__', `happier.agent.${params.extensionId}`)
    .replaceAll('__pluginDisplayName__', params.extensionId)
    .replaceAll('__extensionId__', params.extensionId);
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

function assertCanonicalTemplateFiles(files: readonly TemplateFile[]): void {
  const paths = new Set(files.map((file) => file.relativePath));
  for (const required of ['package.json', 'tsconfig.json', 'src/index.ts']) {
    if (!paths.has(required)) throw new Error(`Missing canonical template file '${required}'`);
  }
  for (const retired of [
    'src/manifest.ts',
    'src/activate.ts',
    'src/cli.ts',
    'src/ui/index.ts',
    'src/agent/index.ts',
    'src/agent/definition.ts',
  ]) {
    if (paths.has(retired)) throw new Error(`Retired template file '${retired}' must not be scaffolded`);
  }
  const source = files.map((file) => file.content).join('\n');
  for (const retired of ['AGENT_DEFINITION', 'PluginApi', 'PluginContext', 'registerAction', 'registerTool', 'onDispose']) {
    if (source.includes(retired)) throw new Error(`Retired authoring token '${retired}' remains in the canonical template`);
  }
}

function renderPackageJson(templateJson: unknown, extensionId: string): Record<string, unknown> {
  if (typeof templateJson !== 'object' || templateJson === null || Array.isArray(templateJson)) {
    throw new Error('Canonical template package.json must contain a JSON object');
  }
  const expectedName = `@happier-dev/plugins-${extensionId}`;
  return {
    ...templateJson as Record<string, unknown>,
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
  assertCanonicalTemplateFiles(files);
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
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
