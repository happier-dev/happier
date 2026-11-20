import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import semver from 'semver';
import { z } from 'zod';
import { isPortableRelativePath } from '@happier-dev/protocol/filesystem/portablePathSegment';
import { PluginMcpServerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/mcp';
import { PluginWorkflowContributionV1Schema } from '@happier-dev/protocol/plugins/manifest';
import type { PluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import type { PluginContentNotImportedV1 } from '@happier-dev/protocol/plugins/source-spec';
import { McpRemoteUrlV1Schema } from '@happier-dev/protocol/mcp/remoteUrlV1';
import { readSkillFrontmatterV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

type Fields = Record<string, unknown>;
type Contributions = NonNullable<PluginManifestV2['contributes']>;
type McpServers = NonNullable<NonNullable<Contributions['mcp']>['servers']>;
const agentPluginsV1 = 'https://agent-plugins.org/schemas/1.0.0/';
const happierExtension = 'dev.happier';
const portableManifest = z.object({
  $schema: z.literal(`${agentPluginsV1}plugin.schema.json`),
  name: z.string().min(1).max(64).regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z.strictObject({ name: z.string().optional(), email: z.string().optional(), url: z.string().optional() }).optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  extensions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});
const layouts = [
  { manifest: 'plugin.json', mcp: 'mcp.json' },
  { manifest: '.claude-plugin/plugin.json', mcp: '.mcp.json' },
  { manifest: '.codex-plugin/plugin.json', mcp: '.mcp.json' },
  { manifest: '.cursor-plugin/plugin.json', mcp: '.mcp.json' },
] as const;

export type VendorContentProjection = Readonly<{
  manifest: PluginManifestV2;
  files: ReadonlyMap<string, string>;
  notImported: PluginContentNotImportedV1;
}>;

function fields(value: unknown): Fields | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined;
}

async function confinedPath(root: string, path: string) {
  if (!isPortableRelativePath(path)) return null;
  try {
    const absolute = join(root, path);
    // Do not dereference a package link outside a person-selected root during preview.
    const actual = await realpath(absolute);
    const fromRoot = relative(root, actual);
    if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\')) return null;
    return await lstat(absolute).then(stat => stat.isSymbolicLink() ? null : { absolute, stat });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function text(root: string, path: string): Promise<string | undefined> {
  const location = await confinedPath(root, path);
  return location?.stat.isFile() ? await readFile(location.absolute, 'utf8') : undefined;
}

async function directory(root: string, path: string) {
  const location = await confinedPath(root, path);
  return location?.stat.isDirectory() ? await readdir(location.absolute, { withFileTypes: true }) : [];
}

async function markdownFiles(root: string, folder: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await directory(root, folder)) {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await markdownFiles(root, path));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}

function localId(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function readJson(raw: string | undefined): Fields | undefined {
  if (raw === undefined) return undefined;
  try { return fields(JSON.parse(raw)); } catch { return undefined; }
}

function admitHappierExtension(extensions: Fields | undefined, servers: McpServers, omissions: Set<string>) {
  const workflows: NonNullable<Contributions['workflows']> = [];
  for (const [namespace, raw] of Object.entries(extensions ?? {})) {
    const path = `extensions.${namespace}`;
    const extension = fields(raw);
    if (namespace !== happierExtension || !extension) {
      omissions.add(path);
      continue;
    }
    for (const key of Object.keys(extension)) if (key !== 'contributes') omissions.add(`${path}.${key}`);
    const contributes = fields(extension.contributes);
    if (extension.contributes !== undefined && !contributes) omissions.add(`${path}.contributes`);
    if (!contributes) continue;
    const contributionPath = `${path}.contributes`;
    for (const key of Object.keys(contributes)) {
      if (key !== 'workflows' && key !== 'mcp') omissions.add(`${contributionPath}.${key}`);
    }
    if (Array.isArray(contributes.workflows)) {
      for (const rawWorkflow of contributes.workflows) {
        const workflow = PluginWorkflowContributionV1Schema.safeParse(rawWorkflow);
        if (workflow.success && !workflows.some(existing => existing.id === workflow.data.id)) workflows.push(workflow.data);
        else omissions.add(`${contributionPath}.workflows`);
      }
    } else if (contributes.workflows !== undefined) omissions.add(`${contributionPath}.workflows`);

    const mcp = fields(contributes.mcp);
    if (contributes.mcp !== undefined && !mcp) omissions.add(`${contributionPath}.mcp`);
    if (!mcp) continue;
    for (const key of Object.keys(mcp)) if (key !== 'servers') omissions.add(`${contributionPath}.mcp.${key}`);
    const serverPath = `${contributionPath}.mcp.servers`;
    if (!Array.isArray(mcp.servers)) {
      if (mcp.servers !== undefined) omissions.add(serverPath);
      continue;
    }
    for (const rawServer of mcp.servers) {
      const parsed = PluginMcpServerContributionV1Schema.safeParse(rawServer);
      if (!parsed.success || parsed.data.kind !== 'static' || parsed.data.transport.kind !== 'http' || parsed.data.transport.url.includes('${')) {
        omissions.add(serverPath);
        continue;
      }
      const server = parsed.data;
      const index = servers.findIndex(existing => existing.id === server.id);
      const existing = servers[index];
      if (!existing) {
        servers.push(server);
      } else if (existing.kind === 'static' && existing.transport.kind === 'http' && existing.transport.url === server.transport.url) {
        if (server.transport.auth) servers[index] = { ...existing, transport: { ...existing.transport, auth: server.transport.auth } };
      } else {
        omissions.add(serverPath);
      }
    }
  }
  return workflows;
}

export async function projectVendorPluginContent(root: string, identity: string): Promise<VendorContentProjection | null> {
  let metadata: Fields | undefined;
  let mcpPath: string | undefined;
  let portable = false;
  const other = new Set<string>();
  for (const layout of layouts) {
    const raw = await text(root, layout.manifest);
    if (raw === undefined) continue;
    const candidate = readJson(raw);
    if (layout.manifest === 'plugin.json' && (typeof candidate?.$schema !== 'string' || !candidate.$schema.startsWith('https://agent-plugins.org/'))) continue;
    if (!candidate || typeof candidate.name !== 'string' || !candidate.name.trim()) throw new Error(`Invalid vendor plugin manifest (${layout.manifest})`);
    if (layout.manifest === 'plugin.json') {
      if (candidate.$schema !== portableManifest.shape.$schema.value) throw new Error('Unsupported Agent Plugins specification version');
      const manifest = portableManifest.safeParse(candidate);
      if (!manifest.success) throw new Error(`Invalid Agent Plugins manifest (${manifest.error.issues[0]?.path.join('.') || 'plugin.json'})`);
      for (const key of Object.keys(candidate)) if (!Object.hasOwn(portableManifest.shape, key)) other.add(key);
      metadata = manifest.data;
    } else {
      metadata = candidate;
    }
    mcpPath = layout.mcp;
    portable = layout.manifest === 'plugin.json';
    break;
  }
  if (!metadata || !mcpPath || typeof metadata.name !== 'string') return null;

  const skills: NonNullable<Contributions['skills']> = [];
  const systemTools: NonNullable<Contributions['systemTools']> = [];
  const servers: McpServers = [];
  const files = new Map<string, string>();
  const skillIds = new Set<string>();
  const notImported = { hooks: 0, commands: 0, agents: 0, mcpServers: 0 };
  const appendSkill = (id: string, folder: string) => {
    if (!id || skillIds.has(id)) return false;
    skillIds.add(id);
    skills.push({ id, directory: folder });
    return true;
  };
  const skillPaths = (await directory(root, 'skills')).filter(entry => entry.isDirectory()).map(entry => `skills/${entry.name}`);
  const declaredSkills = Array.isArray(metadata.skills) ? metadata.skills : metadata.skills === undefined ? [] : [metadata.skills];
  for (const declaration of declaredSkills) {
    if (typeof declaration === 'string') skillPaths.push(declaration.replace(/^\.\//, '').replace(/\/SKILL\.md$/, '').replace(/\/$/, ''));
    else other.add('skills');
  }
  for (const path of new Set(skillPaths)) {
    const markdown = await text(root, `${path}/SKILL.md`);
    if (!markdown || !appendSkill(localId(basename(path)), path)) other.add('skills');
  }

  for (const family of ['commands', 'agents'] as const) {
    const filesByPath = new Set(await markdownFiles(root, family));
    const declarations = Array.isArray(metadata[family]) ? metadata[family] : metadata[family] === undefined ? [] : [metadata[family]];
    for (const declaration of declarations) {
      if (typeof declaration !== 'string') { notImported[family]++; continue; }
      const path = declaration.replace(/^\.\//, '').replace(/\/$/, '');
      if (path.endsWith('.md')) filesByPath.add(path);
      else {
        const found = await markdownFiles(root, path);
        if (found.length === 0) notImported[family]++;
        for (const file of found) filesByPath.add(file);
      }
    }
    for (const path of filesByPath) {
      const markdown = await text(root, path);
      const name = localId((path.startsWith(`${family}/`) ? path.slice(family.length + 1) : path).slice(0, -3));
      const id = `${family === 'commands' ? 'command' : 'agent'}-${name}`;
      const destination = `.happier-plugin/imported/${id}`;
      if (!markdown || !name || !appendSkill(id, destination)) { notImported[family]++; continue; }
      const description = readSkillFrontmatterV1(markdown).description || `${family === 'commands' ? 'Command' : 'Agent'}: ${basename(path, '.md')}`;
      files.set(`${destination}/SKILL.md`, `---\nname: ${id}\ndescription: ${JSON.stringify(description)}\n---\n${markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '')}`);
    }
  }

  const nativeMcp = metadata.mcpServers;
  const extraMcpPath = typeof nativeMcp === 'string' ? nativeMcp.replace(/^\.\//, '') : undefined;
  const rawMcp = await text(root, extraMcpPath ?? mcpPath);
  let mcpFile = readJson(rawMcp);
  if (portable && rawMcp !== undefined && (mcpFile?.$schema !== `${agentPluginsV1}mcp.schema.json` || !fields(mcpFile.mcpServers))) {
    notImported.mcpServers++;
    mcpFile = undefined;
  }
  const entries = { ...fields(mcpFile?.mcpServers ?? (portable ? undefined : mcpFile)), ...fields(nativeMcp) };
  if (nativeMcp !== undefined && !fields(nativeMcp) && (!extraMcpPath || !mcpFile)) notImported.mcpServers++;
  for (const [name, raw] of Object.entries(entries)) {
    const entry = fields(raw);
    const id = localId(name);
    if (!id || !entry || servers.some(server => server.id === id)) { notImported.mcpServers++; continue; }
    const http = entry.type === 'streamable-http' || !portable && (entry.type === 'http' || entry.type === undefined);
    if (http && typeof entry.url === 'string' && !entry.url.includes('\${') && entry.headers === undefined
      && McpRemoteUrlV1Schema.safeParse(entry.url).success) {
      const vendorOAuth = portable ? undefined : fields(entry.oauth);
      // The existing Connected Services owner discovers and registers its own OAuth client.
      if (entry.oauth !== undefined && (!vendorOAuth || Object.keys(vendorOAuth).length > 0)) other.add(`mcpServers.${name}.oauth`);
      servers.push({ id, title: name, kind: 'static', transport: { kind: 'http', url: entry.url,
        ...(vendorOAuth ? { auth: { kind: 'oauth' } } : {}) } });
      continue;
    }
    const stdio = entry.type === 'stdio' || !portable && entry.type === undefined;
    if (stdio && typeof entry.command === 'string' && /^[\w.-]+$/.test(entry.command) && entry.env === undefined && entry.cwd === undefined
      && (entry.args === undefined || Array.isArray(entry.args) && entry.args.every(arg => typeof arg === 'string' && !arg.includes('\${') && !arg.includes('\0')))) {
      const toolId = `mcp-${id}`;
      systemTools.push({ id: toolId, title: name, executableNames: [entry.command] });
      servers.push({ id, title: name, kind: 'static', transport: { kind: 'stdio', executable: { kind: 'systemTool', id: toolId },
        ...(Array.isArray(entry.args) ? { args: entry.args } : {}) } });
      continue;
    }
    notImported.mcpServers++;
  }
  const workflows = admitHappierExtension(fields(metadata.extensions), servers, other);
  const hooks = metadata.hooks ?? readJson(await text(root, 'hooks/hooks.json'))?.hooks;
  notImported.hooks = Array.isArray(hooks) ? hooks.length : Object.keys(fields(hooks) ?? {}).length || (hooks ? 1 : 0);
  for (const key of ['rules', 'lspServers', 'app', 'outputStyles'] as const) if (metadata[key] !== undefined) other.add(key);
  if ((await directory(root, 'rules')).length) other.add('rules');
  if (await confinedPath(root, '.app.json')) other.add('app');
  if (await confinedPath(root, '.lsp.json')) other.add('lspServers');
  const id = createHash('sha256').update(identity).digest('hex');
  return {
    manifest: { schemaVersion: 2, id: `imported.${id}`, displayName: metadata.name.trim(),
      version: typeof metadata.version === 'string' && semver.valid(metadata.version) === metadata.version ? metadata.version : '0.0.0',
      ...(typeof metadata.description === 'string' ? { description: metadata.description } : {}),
      contributes: { skills, systemTools, mcp: { servers }, ...(workflows.length ? { workflows } : {}) } },
    files,
    notImported: { ...notImported, ...(other.size ? { other: [...other] } : {}) },
  };
}
