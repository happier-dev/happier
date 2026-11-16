import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { FoundSkillBundleV1Schema, type FoundSkillBundleV1, type FoundSkillDownloadRequestV1 } from '@happier-dev/protocol/prompts/library/skills/foundSkillTransferV1';
import type { DownloadTransferSource } from '@happier-dev/transfers/node';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { resolveAgentFoundSkillSources } from '@/agent/skills/resolveAgentSkillsCapability';
import { buildPromptBundleBodyFromDirectory } from '@/prompts/assets/shared/promptBundleDirectory';
import { canonicalAbsolutePathsEqual, expandHomeDirPath, resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { scanNativeSkillRoots, type FoundNativeSkillScanInput } from './scanNativeSkillRoots';
import { writeFoundSkillTransferPayload } from './foundSkillTransferPayload';

export type FoundSkillReadOptions = Readonly<{ home?: string; agents?: FoundNativeSkillScanInput['agents']; signal?: AbortSignal }>;

/** Native-root discovery is the only authority for Found byte reads on this machine. */
export async function readFoundSkillBundle(input: FoundSkillReadOptions & Readonly<{ request: FoundSkillDownloadRequestV1 }>): Promise<FoundSkillBundleV1> {
  input.signal?.throwIfAborted();
  const environment = sessionProcessEnvironment();
  const home = input.home ?? resolveHomeDirFromEnvironment(environment);
  const path = expandHomeDirPath(input.request.path, { ...environment, HOME: home, USERPROFILE: home });
  if (!isAbsolute(path) || input.request.path.split(/[\\/]/u).includes('..')) {
    throw Object.assign(new Error('not_found'), { code: 'not_found' });
  }
  const catalog = input.agents ? null : readAgentCatalogSnapshot();
  const agents = input.agents ?? resolveAgentFoundSkillSources(catalog!);
  const scan = await scanNativeSkillRoots({ purpose: 'found', home, agents, skillPath: path, signal: input.signal });
  input.signal?.throwIfAborted();
  let item = scan.items.find(item => canonicalAbsolutePathsEqual(item.path, path));
  if (!item) {
    // Only project paths need a directory context. Preserve the default Found
    // provenance for user/plugin paths instead of adding project-only readers.
    const projectScan = await scanNativeSkillRoots({ purpose: 'found', home, agents, directory: dirname(path), skillPath: path, signal: input.signal });
    input.signal?.throwIfAborted();
    item = projectScan.items.find(item => canonicalAbsolutePathsEqual(item.path, path));
  }
  if (!item) throw Object.assign(new Error('not_found'), { code: 'not_found' });
  const body = buildPromptBundleBodyFromDirectory({ rootDirectory: await realpath(item.path), preferredFirstPath: 'SKILL.md' });
  input.signal?.throwIfAborted();
  return FoundSkillBundleV1Schema.parse({ name: item.name, path: item.path, agents: item.agents,
    pluginOwned: item.pluginOwned, files: body.entries });
}

export async function resolveFoundSkillDownloadSource(input: FoundSkillReadOptions & Readonly<{ request: FoundSkillDownloadRequestV1 }>): Promise<
  Readonly<{ success: true; source: DownloadTransferSource }> | Readonly<{ success: false; error: string; code: string }>
> {
  try {
    const payload = await readFoundSkillBundle(input);
    return { success: true, source: await writeFoundSkillTransferPayload(payload) };
  } catch (error) {
    const sourceCode = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
    const code = input.signal?.aborted ? 'cancelled' : sourceCode === 'ENOENT' || sourceCode === 'ENOTDIR' ? 'not_found'
      : typeof sourceCode === 'string' ? sourceCode : 'found_skill_download_failed';
    return { success: false, code, error: code === 'not_found' || code === 'cancelled' ? code
      : error instanceof Error ? error.message : code };
  }
}
