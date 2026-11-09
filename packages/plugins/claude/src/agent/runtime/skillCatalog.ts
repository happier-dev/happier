import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { AgentSessionCatalogControl, AgentSessionOpenRequest, AgentSessionSkillDelivery, SkillCatalogItemV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { isCanonicalAbsolutePathInsideRoot } from '@happier-dev/plugin-sdk/fs';
import { readSkillFrontmatterV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { CLAUDE_NATIVE_CATALOG_COMMAND, parseClaudeNativeCatalogsOutput } from '../preflight/catalogs.js';
import { resolveClaudeNativePluginSkillRoots } from '../preflight/pluginSkillRoots.js';
import { resolveClaudeConfigDir } from '../environment.js';
import { buildClaudePluginDirArgs } from './pluginDirArgs.js';
import { resolveClaudeLaunchSettingsOverlayArgs, resolveClaudeNativeBaseLaunchEnvironment } from './launchSettings.js';

function missing(error: unknown) {
  return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT');
}

/** Membership comes only from native initialization. Files supply source paths,
 * never an independent inventory or a replacement enablement decision.
 */
async function attachSourcePaths(items: readonly SkillCatalogItemV1[], request: AgentSessionOpenRequest, env: NodeJS.ProcessEnv) {
  if (items.length === 0) return [];
  type Root = Readonly<{ path: string; prefix: string; source: 'user' | 'project' | 'plugin'; single?: boolean; confinementRoot?: string }>;
  const roots: Root[] = [{ path: join(resolveClaudeConfigDir(env), 'skills'), prefix: '', source: 'user' }];
  for (let directory = request.cwd;;) {
    roots.push({ path: join(directory, '.claude', 'skills'), prefix: '', source: 'project' });
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (request.skills) roots.push({ path: request.skills.skillsRoot, prefix: 'happier:', source: 'plugin' });
  const home = env.HOME ?? env.USERPROFILE;
  if (home) for (const root of await resolveClaudeNativePluginSkillRoots({ homeDirectory: home, directory: request.cwd }, env)) {
    if (root.status !== 'ok') throw new Error('Claude plugin skill sources are unavailable');
    roots.push({ path: root.path, prefix: `${root.pluginName}:`, source: 'plugin', single: root.layout === 'skill', confinementRoot: root.confinementRoot });
  }
  const paths = new Map<string, Set<string>>();
  for (const root of roots) {
    let directories: readonly string[];
    try { directories = root.single ? [root.path] : (await readdir(root.path)).map(name => join(root.path, name)); }
    catch (error) { if (missing(error)) continue; throw error; }
    for (const directory of directories) {
      const file = join(directory, 'SKILL.md');
      try {
        if (!(await stat(file)).isFile()) continue;
        const path = await realpath(file);
        if (root.confinementRoot && !isCanonicalAbsolutePathInsideRoot(await realpath(root.confinementRoot), path)) continue;
        const name = `${root.prefix}${readSkillFrontmatterV1(await readFile(file, 'utf8')).name ?? basename(directory)}`;
        const item = items.find(item => item.name === name && (!/\((?:user|project)\)$/.test(item.description ?? '')
          || item.description!.endsWith(`(${root.source})`)));
        if (!item || item.path) continue;
        const candidates = paths.get(item.id) ?? new Set<string>();
        // Preserve the native reference path for host-owned linked delivery trees.
        // Installed plugin confinement above still checks the physical destination.
        candidates.add(file);
        paths.set(item.id, candidates);
      } catch (error) {
        if (missing(error) || (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOTDIR')) continue;
        throw error;
      }
    }
  }
  return items.map(item => {
    const candidates = paths.get(item.id);
    // Native versions that omit provenance cannot disambiguate two physical sources.
    const resolved = !item.path && candidates?.size === 1 ? { ...item, path: [...candidates][0]! } : item;
    const delivered = request.skills?.items.find(delivery => `happier:${delivery.name}` === item.name
      && resolved.path === join(delivery.directory, 'SKILL.md'));
    return delivered ? { ...resolved, id: delivered.skillId, origin: 'happier' as const } : resolved;
  });
}

export function createClaudeSessionSkillCatalog() {
  const launches = new Map<string, { request: AgentSessionOpenRequest }>();
  const control: AgentSessionCatalogControl = {
    async list(request, context, options) {
      if (request.kind !== 'skills') return { status: 'unsupported', diagnostic: { code: 'claude_vendor_catalog_unsupported', severity: 'error', message: 'Claude does not expose a vendor plugin mention catalog.' } };
      const launch = launches.get(context.session.id)?.request;
      if (!launch) return { status: 'unavailable', retryable: true, diagnostic: { code: 'claude_skill_catalog_unavailable', severity: 'error', message: 'Claude Session is unavailable.' } };
      const signal = options?.signal ?? context.signal;
      try {
        signal?.throwIfAborted();
        const env = resolveClaudeNativeBaseLaunchEnvironment({ launchEnvironment: launch.launchEnvironment, processEnv: process.env });
        const values = (await context.services.settings.forScope({ kind: 'account' }).snapshot()).values;
        const command = CLAUDE_NATIVE_CATALOG_COMMAND;
        const resolved = await context.services.exec.systemTools.resolve({ toolId: command.toolId, purpose: 'Read Claude Session skill catalog', cwd: launch.cwd, signal });
        const prepared = command.prepareCommand({ accountSettings: null, environment: {}, pluginSettings: { account: values } });
        const args = resolveClaudeLaunchSettingsOverlayArgs({
          args: [...prepared.args, ...buildClaudePluginDirArgs({ skills: launch.skills })],
          interactionKind: 'noninteractive_sdk', permissionMode: null, launchSettings: {}, launchEnv: env,
          cwd: launch.cwd,
          skillOverrides: Object.fromEntries((launch.skills?.nativeDisables ?? []).map(item => [item.name, 'off' as const])),
        });
        const result = await context.services.exec.run({ executable: resolved.executable,
          args, cwd: launch.cwd, env,
          stdin: new TextEncoder().encode(command.stdin),
        }, { signal });
        const exitCode = result.termination.observed.kind === 'exit' ? result.termination.observed.exitCode : null;
        const native = parseClaudeNativeCatalogsOutput({ ok: exitCode === 0, exitCode,
          stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) });
        const items = await attachSourcePaths(native.skills, launch, env);
        signal?.throwIfAborted();
        return { status: 'ok', kind: 'skills', items };
      } catch {
        return { status: 'unavailable', retryable: true, diagnostic: { code: 'claude_skill_catalog_read_failed', severity: 'error', message: 'Claude Session skill catalog could not be read.' } };
      }
    },
  };
  return { control, bind(request: AgentSessionOpenRequest) {
    const binding = { request };
    launches.set(request.sessionId, binding);
    return {
      updateSkills(skills: AgentSessionSkillDelivery) {
        binding.request = { ...binding.request, skills: { ...skills, nativeDisables: request.skills?.nativeDisables ?? [] } };
      },
      dispose() { if (launches.get(request.sessionId) === binding) launches.delete(request.sessionId); },
    };
  } };
}
