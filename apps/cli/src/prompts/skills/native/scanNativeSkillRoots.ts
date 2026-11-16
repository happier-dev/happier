import type { PluginAgentSkillsCapabilityV2 } from '@happier-dev/protocol';
import type { AgentPreflightSessionControlsContributionV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { NativeSkillScanV1 } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';
import { readSkillFrontmatterV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { buildPromptBundleBodyFromDirectory } from '@/prompts/assets/shared/promptBundleDirectory';
import { expandHomeDirPath, isCanonicalAbsolutePathInsideRoot, resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath';
import { sessionProcessEnvironment, sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';

type NativeRoots = PluginAgentSkillsCapabilityV2['nativeRoots'];
type MaskingScanInput = Readonly<{ purpose?: 'masking'; nativeRoots: NativeRoots; directory?: string | null; home?: string;
  additionalProjectDirectories?: readonly string[] }>;
export type FoundNativeSkillScanInput = Readonly<{
  purpose: 'found'; agents: readonly Readonly<{ agentId: string; nativeRoots?: NativeRoots;
    resolveNativePluginSkillRoots?: AgentPreflightSessionControlsContributionV1['resolveNativePluginSkillRoots'] }>[];
  directory?: string | null; home?: string; skillPath?: string; signal?: AbortSignal;
}>;
export type FoundNativeSkillRoot = Readonly<{
  path: string; scope: 'user' | 'project' | 'plugin'; agents: readonly string[]; status: 'ok' | 'failed';
}>;
export type FoundNativeSkillItem = Readonly<{
  name: string; description: string | null; path: string; digest: string; userInvocable: boolean;
  agents: readonly string[]; scope: FoundNativeSkillRoot['scope']; pluginOwned: Readonly<{ pluginName: string }> | null;
}>;
export type FoundNativeSkillScan = Readonly<{ roots: readonly FoundNativeSkillRoot[]; items: readonly FoundNativeSkillItem[] }>;
type ScanRoot = {
  path: string; scope: FoundNativeSkillRoot['scope']; agents: string[]; status: 'ok' | 'failed';
  pluginName: string | null; confinementRoot?: string; layout?: 'collection' | 'skill';
};

function missing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
}

async function resolveContentRoot(path: string, confinementRoot?: string): Promise<string> {
  const contentRoot = await realpath(path);
  if (confinementRoot && !isCanonicalAbsolutePathInsideRoot(confinementRoot, contentRoot)) {
    throw new Error('Plugin skill path leaves its declared root');
  }
  return contentRoot;
}

/** Expand declared patterns for Agents without an installed-plugin root contribution. */
async function expandPluginRoots(home: string, pattern: readonly string[]): Promise<Array<{
  path: string; status: 'ok' | 'failed'; pluginName: string | null; confinementRoot: string;
}>> {
  const dynamicIndex = pattern.findIndex(segment => segment === '*' || segment === '{plugin}');
  const base = join(home, ...pattern.slice(0, dynamicIndex < 0 ? pattern.length : dynamicIndex));
  let confinementRoot: string;
  try { confinementRoot = await realpath(base); }
  catch (error) { return [{ path: base, status: missing(error) ? 'ok' : 'failed', pluginName: null, confinementRoot: base }]; }
  const failures: Array<{ path: string; status: 'failed'; pluginName: string | null; confinementRoot: string }> = [];
  let candidates: Array<{ path: string; pluginName: string | null; modifiedAtMs: number }> = [{ path: base, pluginName: null, modifiedAtMs: 0 }];
  for (const segment of pattern.slice(dynamicIndex < 0 ? pattern.length : dynamicIndex)) {
    const next: typeof candidates = [];
    for (const candidate of candidates) {
      let children: string[];
      try { children = segment === '*' || segment === '{plugin}' ? (await readdir(candidate.path)).sort() : [segment]; }
      catch (error) {
        if (!missing(error)) failures.push({ path: candidate.path, status: 'failed', pluginName: candidate.pluginName, confinementRoot });
        continue;
      }
      for (const child of children) {
        const path = join(candidate.path, child);
        try {
          const contentRoot = await resolveContentRoot(path, confinementRoot);
          const metadata = await stat(contentRoot);
          if (!metadata.isDirectory()) continue;
          next.push({ path, pluginName: segment === '{plugin}' ? child : candidate.pluginName,
            modifiedAtMs: segment === '*' && candidate.pluginName !== null ? metadata.mtimeMs : candidate.modifiedAtMs });
        } catch (error) {
          if (!missing(error)) failures.push({ path, status: 'failed', pluginName: candidate.pluginName, confinementRoot });
        }
      }
    }
    candidates = next;
  }
  const newest = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    if (candidate.pluginName === null) {
      failures.push({ path: candidate.path, status: 'failed', pluginName: null, confinementRoot });
      continue;
    }
    const incumbent = newest.get(candidate.pluginName);
    if (!incumbent || candidate.modifiedAtMs > incumbent.modifiedAtMs) newest.set(candidate.pluginName, candidate);
  }
  return [...failures, ...[...newest.values()].map(candidate => ({ path: candidate.path, status: 'ok' as const,
    pluginName: candidate.pluginName, confinementRoot }))];
}

/** Masking reads only the Agent's declared user/project roots; plugin-owned roots belong to Found. */
export function scanNativeSkillRoots(input: MaskingScanInput): Promise<NativeSkillScanV1>;
export function scanNativeSkillRoots(input: FoundNativeSkillScanInput): Promise<FoundNativeSkillScan>;
export async function scanNativeSkillRoots(input: MaskingScanInput | FoundNativeSkillScanInput): Promise<NativeSkillScanV1 | FoundNativeSkillScan> {
  const agents = input.purpose === 'found' ? input.agents : [{ agentId: '', nativeRoots: input.nativeRoots }];
  const environment = sessionProcessEnvironment();
  const workingDirectory = sessionWorkingDirectory();
  const home = input.home ?? resolveHomeDirFromEnvironment(environment);
  const pathEnvironment = { ...environment, HOME: home, USERPROFILE: home };
  const projectDirectory = input.directory ? resolve(workingDirectory, expandHomeDirPath(input.directory, pathEnvironment)) : workingDirectory;
  const roots = new Map<string, ScanRoot>();
  function addRoot(path: string, scope: ScanRoot['scope'], agentIds: readonly string[], options?: Partial<Pick<ScanRoot, 'status' | 'pluginName' | 'confinementRoot' | 'layout'>>) {
    const key = resolve(path);
    let root = roots.get(key);
    if (!root) {
      root = { path, scope, agents: [], status: 'ok', pluginName: null, ...options };
      roots.set(key, root);
    } else if (options?.status === 'failed') root.status = 'failed';
    for (const agentId of agentIds) if (agentId && !root.agents.includes(agentId)) root.agents.push(agentId);
  }
  for (const agent of agents) for (const segments of agent.nativeRoots?.user ?? []) addRoot(join(home, ...segments), 'user', [agent.agentId]);
  if (input.purpose !== 'found') for (const extra of input.additionalProjectDirectories ?? []) {
    const directory = resolve(projectDirectory, expandHomeDirPath(extra, pathEnvironment));
    for (const segments of input.nativeRoots?.project ?? []) addRoot(join(directory, ...segments), 'project', []);
  }
  const failed: string[] = [];
  if (input.directory) {
    let directory = projectDirectory;
    while (true) {
      for (const agent of agents) for (const segments of agent.nativeRoots?.project ?? []) addRoot(join(directory, ...segments), 'project', [agent.agentId]);
      try { await lstat(join(directory, '.git')); break; }
      catch (error) {
        if (!missing(error)) {
          failed.push(directory);
          if (input.purpose === 'found') addRoot(directory, 'project', agents.filter(agent => agent.nativeRoots?.project?.length).map(agent => agent.agentId), { status: 'failed' });
          break;
        }
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  if (input.purpose === 'found') {
    for (const agent of input.agents) {
      if (!agent.resolveNativePluginSkillRoots) continue;
      try {
        const pluginRoots = await agent.resolveNativePluginSkillRoots({ homeDirectory: home, directory: input.directory,
          skillPath: input.skillPath, signal: input.signal });
        for (const root of pluginRoots) addRoot(root.path, 'plugin', [agent.agentId], root);
      } catch {
        input.signal?.throwIfAborted();
        // Failure cannot fall back to a cache inventory that lacks installed/enabled authority.
        addRoot(home, 'plugin', [agent.agentId], { status: 'failed' });
      }
    }
    const patterns = new Map<string, { pattern: readonly string[]; agentIds: string[] }>();
    for (const agent of input.agents.filter(agent => !agent.resolveNativePluginSkillRoots)) for (const pattern of agent.nativeRoots?.plugin ?? []) {
      const key = JSON.stringify(pattern);
      let declaration = patterns.get(key);
      if (!declaration) {
        declaration = { pattern, agentIds: [] };
        patterns.set(key, declaration);
      }
      if (!declaration.agentIds.includes(agent.agentId)) declaration.agentIds.push(agent.agentId);
    }
    for (const { pattern, agentIds } of patterns.values()) for (const root of await expandPluginRoots(home, pattern)) addRoot(root.path, 'plugin', agentIds, root);
  }
  const names: Array<{ name: string; path: string; root: string }> = [];
  const items: Array<Omit<FoundNativeSkillItem, 'agents'> & { agents: string[] }> = [];
  const physicalItems = new Map<string, (typeof items)[number]>();
  const physicalNames = new Set<string>();
  for (const root of roots.values()) {
    if (root.status === 'failed') continue;
    let children: string[];
    try { children = root.layout === 'skill' ? [''] : await readdir(root.path); }
    catch (error) {
      if (missing(error)) {
        // Absent native folders are normal; an existing broken alias is not an empty scan.
        try { await lstat(root.path); }
        catch (metadataError) { if (missing(metadataError)) continue; }
      }
      root.status = 'failed'; failed.push(root.path); continue;
    }
    for (const child of children.sort()) {
      const skillDirectory = join(root.path, child);
      const path = join(skillDirectory, 'SKILL.md');
      try {
        const contentRoot = await resolveContentRoot(skillDirectory, root.confinementRoot);
        if (root.confinementRoot) await resolveContentRoot(path, root.confinementRoot);
        // Follow native links, rejecting special entries before the content read.
        if (!(await stat(path)).isFile()) throw new Error('Native skill entry is not a regular file');
        const frontmatter = readSkillFrontmatterV1(await readFile(path, 'utf8'));
        // Native Agents may accept names outside the library's authoring pattern.
        const name = frontmatter.name ?? (child || basename(skillDirectory));
        if (!physicalNames.has(contentRoot)) { names.push({ name, path, root: root.path }); physicalNames.add(contentRoot); }
        if (input.purpose === 'found') {
          // Plugin provenance remains distinct from user/project masking identity.
          const key = JSON.stringify([contentRoot, root.scope === 'plugin' ? 'plugin' : 'native', root.pluginName]);
          const existing = physicalItems.get(key);
          if (existing) {
            for (const agent of root.agents) if (!existing.agents.includes(agent)) existing.agents.push(agent);
          } else {
            const item = { name, description: frontmatter.description ?? null, path: skillDirectory, userInvocable: frontmatter.userInvocable,
              digest: computePromptBundleDigestV1(buildPromptBundleBodyFromDirectory({ rootDirectory: contentRoot, preferredFirstPath: 'SKILL.md' })),
              agents: [...root.agents], scope: root.scope, pluginOwned: root.pluginName === null ? null : { pluginName: root.pluginName } };
            items.push(item); physicalItems.set(key, item);
          }
        }
      } catch (error) {
        if (error && typeof error === 'object' && ['ENOENT', 'ENOTDIR'].includes(String(Reflect.get(error, 'code')))) continue;
        root.status = 'failed';
        if (!failed.includes(root.path)) failed.push(root.path);
      }
    }
  }
  if (input.purpose === 'found') return { roots: [...roots.values()].map(({ path, scope, agents, status }) => ({ path, scope, agents, status })), items };
  return failed.length > 0 ? { status: 'failed', roots: [...new Set(failed)], names } : { status: 'ok', names };
}
