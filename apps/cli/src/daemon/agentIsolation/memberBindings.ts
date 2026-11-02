import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createMachineSetupNativeBackend, type MachineSetupBackend } from '@happier-dev/cli-common/machineSetup';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { deriveAgentIsolationMemberIdentity, type AgentIsolationMemberIdentity } from './provisioning';
import { observeAgentIsolationMemberNativeIdentity, readAgentIsolationNativeIdentity,
  type AgentIsolationMemberNativeIdentity, type AgentIsolationMemberNativeIdentityInput } from './agentIsolationNativeIdentity';

const bindingSchema = z.object({
  homeServerIdentityId: z.string().min(1), accountId: z.string().min(1), machineId: z.string().min(1), installationId: z.string().min(1),
  username: z.string().regex(/^hpm-[a-f0-9]{24}$/u), uid: z.number().int().positive(), home: z.string().min(1),
}).strict();
export type AgentIsolationMemberBinding = z.infer<typeof bindingSchema>;
export type AgentIsolationMemberBindingScope = Readonly<{
  activeServerDir: string; homeServerIdentityId: string; machineId: string; installationId: string;
}>;
const unavailable = (cause?: unknown) => new PluginError({ code: 'agent_isolation_unavailable',
  message: 'The requester identity binding is unavailable', retryable: false,
  details: { reason: 'requester_authority_unavailable', phase: 'native_identity_binding' } }, { cause });

/** Persisted reverse association is a host projection, never a Machine access grant. */
export function projectAgentIsolationMemberBinding(value: AgentIsolationMemberBinding): AgentIsolationMemberIdentity {
  return deriveAgentIsolationMemberIdentity({ homeServerIdentityId: value.homeServerIdentityId,
    requester: { serverId: value.homeServerIdentityId, accountId: value.accountId, machineId: value.machineId, installationId: value.installationId } });
}

function requireMatch(value: AgentIsolationMemberBinding, observed: AgentIsolationMemberNativeIdentity): void {
  const expected = projectAgentIsolationMemberBinding(value);
  if (expected.digest !== observed.digest || expected.username !== value.username || expected.home !== value.home
    || value.username !== observed.username || value.uid !== observed.agentUid || value.home !== observed.home) throw unavailable();
}

async function privateRoot(activeServerDir: string, create: boolean): Promise<string> {
  if (await realpath(activeServerDir) !== activeServerDir) throw unavailable();
  let current = activeServerDir;
  for (const name of ['agent-isolation', 'members']) {
    current = join(current, name);
    if (create) await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const state = await lstat(current);
    if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid?.() || (state.mode & 0o7777) !== 0o700) throw unavailable();
  }
  return current;
}

async function readBinding(root: string, name: string): Promise<AgentIsolationMemberBinding> {
  const file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = await file.stat();
    if (!state.isFile() || state.uid !== process.getuid?.() || (state.mode & 0o7777) !== 0o600) throw unavailable();
    const value = bindingSchema.parse(JSON.parse(await file.readFile('utf8')));
    const expected = projectAgentIsolationMemberBinding(value);
    if (name !== `${expected.digest}.json` || expected.username !== value.username || expected.home !== value.home) throw unavailable();
    return value;
  } finally { await file.close(); }
}

/** Provisioning commits only after native validation. An exact retry writes nothing. */
export async function writeAgentIsolationMemberBinding(activeServerDir: string, observed: AgentIsolationMemberNativeIdentity): Promise<void> {
  try {
    const value = bindingSchema.parse({ homeServerIdentityId: observed.homeServerIdentityId, accountId: observed.requester.accountId,
      machineId: observed.requester.machineId, installationId: observed.requester.installationId,
      username: observed.username, uid: observed.agentUid, home: observed.home });
    requireMatch(value, observed);
    const root = await privateRoot(activeServerDir, true), name = `${observed.digest}.json`;
    // Existing setup-operation admission serializes this commit. Retained
    // private files reserve UIDs even when their OS account is absent. Ordinary
    // launch readers use the exact binding and never perform this cold scan.
    let ownBinding = false;
    for (const existingName of await readdir(root)) {
      // writeJsonAtomic's uncommitted staging files can survive process loss.
      // They are not retained binding authority; preserve them for recovery.
      if (/^\.tmp-[1-9]\d*--?\d+-[a-f0-9]*\.json$/u.test(existingName)) continue;
      if (!/^[a-f0-9]{64}\.json$/u.test(existingName)) throw unavailable();
      const existing = await readBinding(root, existingName);
      if (existingName === name) { requireMatch(existing, observed); ownBinding = true; }
      else if (existing.uid === value.uid) throw unavailable();
    }
    if (ownBinding) return;
    await writeJsonAtomic(join(root, name), value);
  } catch (cause) { throw unavailable(cause); }
}

/** Reuse the launch's single native observation instead of performing another lookup. */
export async function readAgentIsolationMemberBinding(activeServerDir: string, observed: AgentIsolationMemberNativeIdentity): Promise<AgentIsolationMemberBinding | null> {
  try {
    const root = await privateRoot(activeServerDir, false), value = await readBinding(root, `${observed.digest}.json`);
    requireMatch(value, observed);
    return value;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw unavailable(cause);
  }
}

/** Launch/material/readiness demand consumes the committed host projection.
 * Native setup itself observes before committing, so it uses the native reader
 * directly. Reuse this observation for UID/home/socket/material preparation.
 */
export async function readAgentIsolationMemberLaunchIdentity(input: AgentIsolationMemberNativeIdentityInput & Readonly<{ activeServerDir: string }>,
  backend?: Pick<MachineSetupBackend, 'observe'>,
): Promise<AgentIsolationMemberNativeIdentity> {
  const observed = await readAgentIsolationNativeIdentity(input, backend);
  if (!await readAgentIsolationMemberBinding(input.activeServerDir, observed)) throw unavailable();
  return observed;
}

/** Exact reverse association for access-loss recovery, with no launch authority. */
export async function readAgentIsolationMemberBindingForAccount(scope: AgentIsolationMemberBindingScope, accountId: string): Promise<AgentIsolationMemberBinding | null> {
  try {
    const expected = deriveAgentIsolationMemberIdentity({ homeServerIdentityId: scope.homeServerIdentityId,
      requester: { serverId: scope.homeServerIdentityId, accountId, machineId: scope.machineId, installationId: scope.installationId } });
    const root = await privateRoot(scope.activeServerDir, false);
    return await readBinding(root, `${expected.digest}.json`);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw unavailable(cause);
  }
}

/** Reconnect enumerates existing local projections, never an Account/Team roster. */
export async function readProvisionedRequesterAccounts(scope: AgentIsolationMemberBindingScope,
  backend: Pick<MachineSetupBackend, 'observe'> = createMachineSetupNativeBackend(),
): Promise<Readonly<{ accountIds: readonly string[]; coverage: 'complete' | 'unknown' }>> {
  const accountIds = new Set<string>();
  let coverage: 'complete' | 'unknown' = 'complete';
  let root: string, names: string[];
  try { root = await privateRoot(scope.activeServerDir, false); names = await readdir(root); }
  catch (error) { return { accountIds: [], coverage: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'complete' : 'unknown' }; }
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) { coverage = 'unknown'; continue; }
    try {
      const value = await readBinding(root, name);
      if (value.homeServerIdentityId !== scope.homeServerIdentityId || value.machineId !== scope.machineId
        || value.installationId !== scope.installationId) { coverage = 'unknown'; continue; }
      // The exact private binding supplies a reconciliation subject, never OS
      // authority. A missing/drifted account still needs Home access recovery;
      // native provenance remains mandatory at adoption and retirement.
      accountIds.add(value.accountId);
      const observed = await observeAgentIsolationMemberNativeIdentity(projectAgentIsolationMemberBinding(value), { expectedUid: value.uid }, backend);
      requireMatch(value, observed);
    } catch { coverage = 'unknown'; }
  }
  return { accountIds: [...accountIds].sort(), coverage };
}
