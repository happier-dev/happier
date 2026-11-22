import { join } from 'node:path';

import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { expandHomeDirPath, resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath';
import { verifyResumeReachableAgy } from '../connectedServices/verifyResumeReachableAgy';

/** The home whose `antigravity-acp/` login and conversation store the pinned `agy_acp_server` uses. */
export function resolvePinnedAgyAcpServerHome(env: NodeJS.ProcessEnv): string {
  const configured = env.GEMINI_HOME?.trim();
  return configured ? expandHomeDirPath(configured, env) : join(resolveHomeDirFromEnvironment(env), '.gemini');
}

/** Resolve against the same auth binding and released conversation store for admission and launch. */
export async function resolveAgyAcpRuntime(params: Readonly<{
  vendorResumeId?: string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<'native' | 'pinned' | 'connected'> {
  const env = { ...process.env, ...params.env };
  if (findConnectedServiceChildSelection(env, 'antigravity')) return 'connected';
  if (!params.vendorResumeId) return 'native';
  const home = resolvePinnedAgyAcpServerHome(env);
  const reachable = await verifyResumeReachableAgy({
    targetMaterializedRoot: home,
    targetMaterializedEnv: { GEMINI_HOME: home },
    vendorResumeId: params.vendorResumeId,
    cwd: params.cwd ?? process.cwd(),
  });
  return reachable.ok ? 'pinned' : 'native';
}
