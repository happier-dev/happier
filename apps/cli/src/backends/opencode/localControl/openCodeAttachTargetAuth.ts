import {
  isOpenCodeManagedServerStateTarget,
  resolveOpenCodeManagedServerCredentialChildEnv,
  resolveOpenCodeManagedServerStateCredential,
} from '@/backends/opencode/server/openCodeManagedServerCredential';
import {
  resolveOpenCodeServerAuthCredentialFromEnv,
  resolveOpenCodeServerAuthHeaders,
} from '@/backends/opencode/server/openCodeServerAuth';
import {
  isLoopbackManagedOpenCodeBaseUrl,
  readSharedManagedOpenCodeServerStateByBaseUrlBestEffort,
  readSharedManagedOpenCodeServerStateByLaunchFingerprintBestEffort,
  type SharedManagedOpenCodeServerState,
} from '@/backends/opencode/server/sharedManagedServer';

/**
 * Credentials for an OpenCode attach target (the server a terminal attaches to, or is probed for
 * reachability).
 *
 * A Happier-managed server is password protected, so both the probe and the attached CLI must present
 * the credential retained for THAT server. It is resolved from the canonical managed-server state and
 * only applied when the state describes the exact target `baseUrl`; a remote endpoint keeps exactly the
 * ambient, operator-configured environment credential and never sees Happier's managed password.
 *
 * The attached child receives the credential through the environment only — never argv, where any local
 * process could read it from the process table — and `process.env` is never mutated.
 */

type ReadManagedStateFn = (baseUrl: string) => Promise<SharedManagedOpenCodeServerState | null>;

type TargetAuthParams = Readonly<{
  baseUrl: string;
  env: NodeJS.ProcessEnv;
  readManagedServerStateFn?: ReadManagedStateFn;
  managedServerLaunchFingerprint?: string | null;
}>;

async function readMatchingManagedState(params: TargetAuthParams): Promise<SharedManagedOpenCodeServerState | null> {
  if (!isLoopbackManagedOpenCodeBaseUrl(params.baseUrl)) return null;
  if (params.managedServerLaunchFingerprint != null) {
    const state = await readSharedManagedOpenCodeServerStateByLaunchFingerprintBestEffort(params.managedServerLaunchFingerprint, params.baseUrl);
    if (!isOpenCodeManagedServerStateTarget({ state, baseUrl: params.baseUrl })) {
      throw new Error('Managed OpenCode target credential affinity is unavailable.');
    }
    return state;
  }
  const state = await (params.readManagedServerStateFn ?? readSharedManagedOpenCodeServerStateByBaseUrlBestEffort)(params.baseUrl)
    .catch(() => null);
  return isOpenCodeManagedServerStateTarget({ state, baseUrl: params.baseUrl }) ? state : null;
}

async function resolveTargetCredential(params: TargetAuthParams) {
  const state = await readMatchingManagedState(params);
  return state
    ? resolveOpenCodeManagedServerStateCredential({ state, baseUrl: params.baseUrl, env: params.env })
    : resolveOpenCodeServerAuthCredentialFromEnv(params.env);
}

export async function resolveOpenCodeAttachTargetAuthHeaders(params: Readonly<{
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
  readManagedServerStateFn?: ReadManagedStateFn;
  managedServerLaunchFingerprint?: string | null;
}>): Promise<Record<string, string>> {
  return resolveOpenCodeServerAuthHeaders(await resolveTargetCredential({
    baseUrl: params.baseUrl,
    env: params.env ?? process.env,
    managedServerLaunchFingerprint: params.managedServerLaunchFingerprint,
    ...(params.readManagedServerStateFn ? { readManagedServerStateFn: params.readManagedServerStateFn } : {}),
  }));
}

export async function resolveOpenCodeAttachChildEnv(params: Readonly<{
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
  readManagedServerStateFn?: ReadManagedStateFn;
  managedServerLaunchFingerprint?: string | null;
}>): Promise<NodeJS.ProcessEnv> {
  const env = params.env ?? process.env;
  if (!isLoopbackManagedOpenCodeBaseUrl(params.baseUrl)) return env;
  const targetAuth = {
    baseUrl: params.baseUrl,
    env,
    managedServerLaunchFingerprint: params.managedServerLaunchFingerprint,
    ...(params.readManagedServerStateFn ? { readManagedServerStateFn: params.readManagedServerStateFn } : {}),
  };
  const state = await readMatchingManagedState(targetAuth);
  if (!state) return env;
  const credential = resolveOpenCodeManagedServerStateCredential({ state, baseUrl: params.baseUrl, env });
  if (!credential) return env;
  return { ...env, ...resolveOpenCodeManagedServerCredentialChildEnv(credential) };
}
