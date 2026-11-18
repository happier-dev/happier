import { join } from 'node:path';

import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { expandHomeDirPath, resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath';
import { verifyResumeReachableAgy } from '../connectedServices/verifyResumeReachableAgy';

/** The home whose `antigravity-acp/` login and conversation store the pinned `agy_acp_server` uses. */
export function resolvePinnedAgyAcpServerHome(env: NodeJS.ProcessEnv): string {
  const configured = env.GEMINI_HOME?.trim();
  return configured ? expandHomeDirPath(configured, env) : join(resolveHomeDirFromEnvironment(env), '.gemini');
}

/** Connected accounts keep the pinned server because it reads the credential home Happier materializes per account. */
export function usesPinnedAgyAcpServer(env?: NodeJS.ProcessEnv): boolean {
  return findConnectedServiceChildSelection({ ...process.env, ...env }, 'antigravity') !== null;
}

export async function isPinnedAgyAcpServerConversation(params: Readonly<{
  sessionId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<boolean> {
  const home = resolvePinnedAgyAcpServerHome({ ...process.env, ...params.env });
  const reachable = await verifyResumeReachableAgy({
    targetMaterializedRoot: home,
    targetMaterializedEnv: { GEMINI_HOME: home },
    vendorResumeId: params.sessionId,
    cwd: params.cwd,
  });
  return reachable.ok;
}
