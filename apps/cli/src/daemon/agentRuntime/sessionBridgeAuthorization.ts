import { randomBytes, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { chmod, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { resolveReleaseRingScopedBasename } from '@/cli/runtime/publicReleaseChannel';
import {
  AgentRuntimeDaemonSessionDescriptorV1Schema,
  HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY,
  type AgentRuntimeDaemonSessionDescriptorV1,
} from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import {
  hashPrivateBearer,
  readPrivateBearerFile,
  removePrivateBearerFile,
  replacePrivateBearerFile,
  verifyPrivateBearer,
  writePrivateBearerFile,
} from '@/daemon/privateBearerFile';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import {
  AgentSessionRunnerBindingV1Schema,
  type AgentSessionRunnerBindingV1,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
  readCurrentPluginHardRevocationRevision,
} from '@/plugins/store/registry/generationStore';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import {
  verifyProcessLiveness,
  type VerifiedProcessLiveness,
} from '@/daemon/processLivenessVerifier';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import {
  resolveSessionRunnerEntrypointIdentityFromProcessCommand,
} from '@/daemon/sessionRunnerRuntime/resolveRunnerEntrypointIdentity';

type PublicReleaseRing = Parameters<typeof resolveReleaseRingScopedBasename>[1];

const AgentRuntimeDaemonServiceAuthorityDocumentV2Schema = z.object({
  v: z.literal(2),
  sessionId: z.string().trim().min(1).max(512),
  runner: z.object({
    pid: z.number().int().positive(),
    processStartTimeMs: z.number().int().nonnegative(),
    processCommandHash: z.string().regex(/^[a-f0-9]{64}$/u),
    snapshotIdentity: z.string().trim().min(1).max(2_048),
  }).strict(),
  pluginHardRevocationRevision:
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  retainedAgent: AgentSessionRunnerBindingV1Schema,
  httpPort: z.number().int().min(1).max(65_535),
  capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();

export type AgentRuntimeDaemonServiceAuthorityDocumentV2 = z.infer<
  typeof AgentRuntimeDaemonServiceAuthorityDocumentV2Schema
>;

export type AgentRuntimeDaemonServiceAuthorityRunnerIdentity = Readonly<
  AgentRuntimeDaemonServiceAuthorityDocumentV2['runner']
>;

const AUTHORITY_MUTATION_LOCK_TIMEOUT_MS = 5_000;
const AUTHORITY_MUTATION_LOCK_STALE_AFTER_MS = 30_000;
const AUTHORITY_FILE_BASENAME_PATTERN =
  /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu;

export type ForegroundAgentRuntimeBootstrapAuthorization = Readonly<{
  capabilityHash: string;
  descriptor: AgentRuntimeDaemonSessionDescriptorV1;
  foregroundAdmissionFilePath: string;
  bootstrapFilePath: string;
  authorityFilePath: string;
}>;

export type RunnerAgentSessionBootstrapAuthorization = Readonly<{
  descriptor: AgentRuntimeDaemonSessionDescriptorV1;
  bootstrapFilePath: string;
  authorityFilePath: string;
}>;

export const HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY =
  'HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE';

type AgentRuntimeDaemonServiceAuthorityPathInput = Readonly<{
  happyHomeDir: string;
  publicReleaseRing: PublicReleaseRing;
}>;

export type AgentRuntimeDaemonServiceAuthorityExpectedInput =
  AgentRuntimeDaemonServiceAuthorityPathInput & Readonly<{
    path: string;
    sessionId: string;
    runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
    retainedAgent: AgentSessionRunnerBindingV1;
  }>;

function resolveAgentRuntimeDaemonServiceAuthorityDir(
  input: AgentRuntimeDaemonServiceAuthorityPathInput,
): string {
  return resolve(
    input.happyHomeDir,
    'tmp',
    resolveReleaseRingScopedBasename(
      'agent-runtime-daemon-service-authorities',
      input.publicReleaseRing,
    ),
  );
}

function isExpectedAuthorityPath(
  input: AgentRuntimeDaemonServiceAuthorityPathInput & Readonly<{ path: string }>,
): boolean {
  const expectedDir =
    resolveAgentRuntimeDaemonServiceAuthorityDir(input);
  const path = resolve(input.path);
  return dirname(path) === expectedDir
    && AUTHORITY_FILE_BASENAME_PATTERN.test(basename(path));
}

async function ensurePrivateAuthorityDir(
  input: AgentRuntimeDaemonServiceAuthorityPathInput,
): Promise<string> {
  const authorityDir =
    resolveAgentRuntimeDaemonServiceAuthorityDir(input);
  try {
    const existing = await lstat(authorityDir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error('agent_runtime_daemon_service_authority_path_unsafe');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(authorityDir, { recursive: true, mode: 0o700 });
  }
  const beforeMode = await lstat(authorityDir);
  if (beforeMode.isSymbolicLink() || !beforeMode.isDirectory()) {
    throw new Error('agent_runtime_daemon_service_authority_path_unsafe');
  }
  try {
    await chmod(authorityDir, 0o700);
  } catch {
    // Windows confinement is supplied by the owning Happier runtime root.
  }
  const afterMode = await lstat(authorityDir);
  const currentUid =
    typeof process.getuid === 'function' ? process.getuid() : null;
  const expectedRealAuthorityDir = join(
    await realpath(resolve(input.happyHomeDir)),
    'tmp',
    resolveReleaseRingScopedBasename(
      'agent-runtime-daemon-service-authorities',
      input.publicReleaseRing,
    ),
  );
  if (
    afterMode.isSymbolicLink()
    || !afterMode.isDirectory()
    || (
      process.platform !== 'win32'
      && (afterMode.mode & 0o777) !== 0o700
    )
    || (currentUid !== null && afterMode.uid !== currentUid)
    || await realpath(authorityDir) !== expectedRealAuthorityDir
  ) {
    throw new Error('agent_runtime_daemon_service_authority_path_unsafe');
  }
  return authorityDir;
}

async function withAuthorityMutationLock<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  return await withJsonOwnerFileLock({
    lockPath: `${path}.lock`,
    timeoutMs: AUTHORITY_MUTATION_LOCK_TIMEOUT_MS,
    staleAfterMs: AUTHORITY_MUTATION_LOCK_STALE_AFTER_MS,
    errorCode:
      'agent_runtime_daemon_service_authority_lock_timeout',
  }, operation);
}

export async function createAgentRuntimeDaemonServiceAuthorityPath(
  input: AgentRuntimeDaemonServiceAuthorityPathInput,
): Promise<string> {
  const authorityDir = await ensurePrivateAuthorityDir(input);
  return join(authorityDir, `${process.pid}-${randomUUID()}.json`);
}

export async function publishAgentRuntimeDaemonServiceAuthority(
  input: AgentRuntimeDaemonServiceAuthorityExpectedInput & Readonly<{
    httpPort: number;
    capability?: string;
    expectedPluginHardRevocationRevision?: number;
    readPluginHardRevocationRevision?: (
      pluginId: string,
    ) => Promise<number>;
  }>,
): Promise<Readonly<{
  path: string;
  capabilityDigest: string;
  document: AgentRuntimeDaemonServiceAuthorityDocumentV2;
}>> {
  await ensurePrivateAuthorityDir(input);
  if (!isExpectedAuthorityPath(input)) {
    throw new Error(
      'agent_runtime_daemon_service_authority_path_unsafe',
    );
  }
  const readPluginHardRevocationRevision =
    input.readPluginHardRevocationRevision
    ?? (async (pluginId: string) =>
      await readCurrentPluginHardRevocationRevision({
        paths: resolvePluginStorePaths({
          happyHomeDir: input.happyHomeDir,
        }),
        pluginId,
      }));
  const pluginId = input.retainedAgent.pluginId;
  const pluginHardRevocationRevision =
    input.expectedPluginHardRevocationRevision
    ?? await readPluginHardRevocationRevision(pluginId);
  if (
    await readPluginHardRevocationRevision(pluginId)
      !== pluginHardRevocationRevision
  ) {
    throw new Error(
      'Runner Agent daemon-service authority is hard-revoked before publication',
    );
  }
  const document =
    AgentRuntimeDaemonServiceAuthorityDocumentV2Schema.parse({
      v: 2,
      sessionId: input.sessionId,
      runner: input.runner,
      pluginHardRevocationRevision,
      retainedAgent: input.retainedAgent,
      httpPort: input.httpPort,
      capability:
        input.capability ?? randomBytes(32).toString('base64url'),
    });
  await withAuthorityMutationLock(input.path, async () => {
    await replacePrivateBearerFile({
      path: input.path,
      contents: `${JSON.stringify(document)}\n`,
    });
  });
  if (
    await readPluginHardRevocationRevision(pluginId)
      !== pluginHardRevocationRevision
  ) {
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({
      happyHomeDir: input.happyHomeDir,
      publicReleaseRing: input.publicReleaseRing,
      path: input.path,
      capabilityDigest: hashPrivateBearer(document.capability),
    }).catch(() => false);
    throw new Error(
      'Runner Agent daemon-service authority was hard-revoked during publication',
    );
  }
  return Object.freeze({
    path: input.path,
    capabilityDigest: hashPrivateBearer(document.capability),
    document,
  });
}

export async function readAgentRuntimeDaemonServiceAuthority(
  input: AgentRuntimeDaemonServiceAuthorityExpectedInput,
): Promise<AgentRuntimeDaemonServiceAuthorityDocumentV2 | null> {
  const value = await readStrictAgentRuntimeDaemonServiceAuthorityDocument(
    input,
  );
  if (!value) return null;
  if (
    value.sessionId !== input.sessionId.trim()
    || value.runner.pid !== input.runner.pid
    || value.runner.processStartTimeMs
      !== input.runner.processStartTimeMs
    || value.runner.processCommandHash
      !== input.runner.processCommandHash
    || value.runner.snapshotIdentity
      !== input.runner.snapshotIdentity
    || !isDeepStrictEqual(value.retainedAgent, input.retainedAgent)
  ) {
    return null;
  }
  return value;
}

async function readStrictAgentRuntimeDaemonServiceAuthorityDocument(
  input: AgentRuntimeDaemonServiceAuthorityPathInput & Readonly<{
    path: string;
  }>,
): Promise<AgentRuntimeDaemonServiceAuthorityDocumentV2 | null> {
  try {
    const authorityDir = await ensurePrivateAuthorityDir(input);
    if (
      !isExpectedAuthorityPath(input)
      || dirname(resolve(input.path)) !== authorityDir
    ) {
      return null;
    }
    const document =
      AgentRuntimeDaemonServiceAuthorityDocumentV2Schema.safeParse(
        JSON.parse(await readPrivateBearerFile(input.path)),
      );
    if (!document.success) return null;
    return document.data;
  } catch {
    return null;
  }
}

async function verifyAuthorityRunnerLiveness(
  runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
): Promise<VerifiedProcessLiveness> {
  return await verifyProcessLiveness({
    pid: runner.pid,
    processStartTimeMs: runner.processStartTimeMs,
    verifyIdentity: async (pid) => {
      const identity = await readProcessIdentityByPid(pid);
      if (
        !identity
        || identity.pid !== runner.pid
        || identity.processStartTimeMs !== runner.processStartTimeMs
        || hashProcessCommand(identity.command) !== runner.processCommandHash
      ) {
        return 'mismatch';
      }
      const snapshot =
        resolveSessionRunnerEntrypointIdentityFromProcessCommand(
          identity.command,
        );
      return snapshot.status === 'known'
        && snapshot.comparableId === runner.snapshotIdentity
        ? 'verified'
        : 'mismatch';
    },
  });
}

/**
 * The private authority document is the exact-G custody source before its
 * runner has a session marker. It can only retain bytes; public or private
 * effects still require their separate currentness and bearer checks.
 */
export async function readLiveRunnerAgentDaemonServiceAuthorityRetainedGenerationIds(
  input: AgentRuntimeDaemonServiceAuthorityPathInput & Readonly<{
    verifyRunnerLiveness?: (
      runner: AgentRuntimeDaemonServiceAuthorityRunnerIdentity,
    ) => Promise<VerifiedProcessLiveness>;
  }>,
): Promise<ReadonlySet<string>> {
  let entries: Dirent[];
  try {
    entries = await readdir(
      await ensurePrivateAuthorityDir(input),
      { withFileTypes: true },
    );
  } catch {
    return new Set();
  }
  const retained = new Set<string>();
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (
      !entry.isFile()
      || !AUTHORITY_FILE_BASENAME_PATTERN.test(entry.name)
    ) {
      continue;
    }
    const document = await readStrictAgentRuntimeDaemonServiceAuthorityDocument({
      ...input,
      path: join(
        resolveAgentRuntimeDaemonServiceAuthorityDir(input),
        entry.name,
      ),
    });
    if (!document) continue;
    let liveness: VerifiedProcessLiveness;
    try {
      liveness = await (
        input.verifyRunnerLiveness
        ?? verifyAuthorityRunnerLiveness
      )(document.runner);
    } catch {
      liveness = {
        status: 'unknown',
        pid: document.runner.pid,
        processStartTimeMs: document.runner.processStartTimeMs,
      };
    }
    if (
      liveness.status === 'verified_stopped'
      && liveness.pid === document.runner.pid
      && liveness.processStartTimeMs
        === document.runner.processStartTimeMs
    ) {
      continue;
    }
    retained.add(document.retainedAgent.immutableGenerationId);
  }
  return retained;
}

export async function readCurrentRunnerAgentRuntimeDaemonServiceAuthority(
  input: AgentRuntimeDaemonServiceAuthorityPathInput & Readonly<{
    path: string;
    expectedSessionId?: string;
  }>,
): Promise<AgentRuntimeDaemonServiceAuthorityDocumentV2 | null> {
  const document =
    await readStrictAgentRuntimeDaemonServiceAuthorityDocument(input);
  if (
    !document
    || document.runner.pid !== process.pid
    || (
      input.expectedSessionId !== undefined
      && document.sessionId !== input.expectedSessionId.trim()
    )
  ) {
    return null;
  }
  const processIdentity =
    await readProcessIdentityByPid(process.pid);
  if (
    !processIdentity
    || processIdentity.pid !== process.pid
    || processIdentity.processStartTimeMs
      !== document.runner.processStartTimeMs
    || hashProcessCommand(processIdentity.command)
      !== document.runner.processCommandHash
  ) {
    return null;
  }
  const snapshot =
    resolveSessionRunnerEntrypointIdentityFromProcessCommand(
      processIdentity.command,
    );
  if (
    snapshot.status !== 'known'
    || snapshot.comparableId
      !== document.runner.snapshotIdentity
  ) {
    return null;
  }
  return document;
}

export async function readAgentRuntimeDaemonServiceAuthorityForVerifiedMarker(
  input: AgentRuntimeDaemonServiceAuthorityPathInput & Readonly<{
    path: string;
    sessionId: string;
    runner: Readonly<{
      pid: number;
      processStartTimeMs: number;
      processCommandHash: string;
    }>;
  }>,
): Promise<AgentRuntimeDaemonServiceAuthorityDocumentV2 | null> {
  try {
    const authorityDir = await ensurePrivateAuthorityDir(input);
    if (
      !isExpectedAuthorityPath(input)
      || dirname(resolve(input.path)) !== authorityDir
    ) {
      return null;
    }
    const parsed = AgentRuntimeDaemonServiceAuthorityDocumentV2Schema.safeParse(
      JSON.parse(await readPrivateBearerFile(input.path)),
    );
    if (!parsed.success) return null;
    const document = parsed.data;
    if (
      document.sessionId !== input.sessionId
      || document.runner.pid !== input.runner.pid
      || document.runner.processStartTimeMs !== input.runner.processStartTimeMs
      || document.runner.processCommandHash !== input.runner.processCommandHash
      || !document.retainedAgent
    ) {
      return null;
    }
    return document;
  } catch {
    return null;
  }
}

export async function removeAgentRuntimeDaemonServiceAuthorityIfOwned(
  input: AgentRuntimeDaemonServiceAuthorityPathInput & Readonly<{
    path: string;
    capabilityDigest: string;
  }>,
): Promise<boolean> {
  await ensurePrivateAuthorityDir(input);
  if (!isExpectedAuthorityPath(input)) return false;
  return await withAuthorityMutationLock(input.path, async () => {
    try {
      const document =
        AgentRuntimeDaemonServiceAuthorityDocumentV2Schema.safeParse(
          JSON.parse(await readPrivateBearerFile(input.path)),
        );
      if (
        !document.success
        || !verifyPrivateBearer({
          provided: document.data.capability,
          expectedHash: input.capabilityDigest,
        })
      ) {
        return false;
      }
      await removePrivateBearerFile(input.path);
      return true;
    } catch {
      return false;
    }
  });
}

export function hashAgentRuntimeSessionBridgeToken(token: string): string {
  return hashPrivateBearer(token);
}

export function verifyAgentRuntimeSessionBridgeToken(params: Readonly<{
  providedToken: string;
  expectedTokenHash: string;
}>): boolean {
  return verifyPrivateBearer({
    provided: params.providedToken,
    expectedHash: params.expectedTokenHash,
  });
}

export async function createRunnerAgentSessionBootstrapAuthorization(
  params: Readonly<{
    happyHomeDir: string;
    publicReleaseRing: PublicReleaseRing;
    descriptor: AgentRuntimeDaemonSessionDescriptorV1;
  }>,
): Promise<Readonly<{
  authorization: RunnerAgentSessionBootstrapAuthorization;
  childEnv: Readonly<Record<
    | typeof HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY
    | typeof HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
    string
  >>;
  cleanupBootstrapFile(): Promise<void>;
}>> {
  const descriptor =
    AgentRuntimeDaemonSessionDescriptorV1Schema.parse(
      params.descriptor,
    );
  const dir = join(
    params.happyHomeDir,
    'tmp',
    resolveReleaseRingScopedBasename(
      'runner-agent-session-bootstraps',
      params.publicReleaseRing,
    ),
  );
  const bootstrapFilePath = join(
    dir,
    `${process.pid}-${randomUUID()}.bootstrap.json`,
  );
  const authorityFilePath =
    await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir: params.happyHomeDir,
      publicReleaseRing: params.publicReleaseRing,
    });
  await writePrivateBearerFile({
    path: bootstrapFilePath,
    contents: `${JSON.stringify({ v: 1, descriptor })}\n`,
  });
  return Object.freeze({
    authorization: Object.freeze({
      descriptor,
      bootstrapFilePath,
      authorityFilePath,
    }),
    childEnv: Object.freeze({
      [HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]:
        bootstrapFilePath,
      [HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]:
        authorityFilePath,
    }),
    cleanupBootstrapFile: async () => {
      await removePrivateBearerFile(bootstrapFilePath)
        .catch(() => undefined);
    },
  });
}

export async function createForegroundAgentRuntimeBootstrapAuthorization(params: Readonly<{
  happyHomeDir: string;
  publicReleaseRing: PublicReleaseRing;
  capability: string;
  descriptor: AgentRuntimeDaemonSessionDescriptorV1;
}>): Promise<Readonly<{
  authorization: ForegroundAgentRuntimeBootstrapAuthorization;
  childEnv: Readonly<Record<
    | typeof HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY
    | typeof HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
    string
  >>;
  cleanupBootstrapFiles(): Promise<void>;
}>> {
  const capability = params.capability.trim();
  if (!capability) {
    throw new Error('Foreground Agent runtime capability is required');
  }
  const descriptor = AgentRuntimeDaemonSessionDescriptorV1Schema.parse(params.descriptor);
  const dir = join(
    params.happyHomeDir,
    'tmp',
    resolveReleaseRingScopedBasename(
      'foreground-agent-runtime-bootstraps',
      params.publicReleaseRing,
    ),
  );
  const bootstrapFilePath = join(
    dir,
    `${process.pid}-${randomUUID()}.bootstrap.json`,
  );
  const foregroundAdmissionFilePath = join(
    dir,
    `${process.pid}-${randomUUID()}.foreground.json`,
  );
  const authorityFilePath =
    await createAgentRuntimeDaemonServiceAuthorityPath({
      happyHomeDir: params.happyHomeDir,
      publicReleaseRing: params.publicReleaseRing,
    });
  await writePrivateBearerFile({
    path: foregroundAdmissionFilePath,
    contents: `${JSON.stringify({
      v: 1,
      capability,
      descriptor,
    })}\n`,
  });
  await writePrivateBearerFile({
    path: bootstrapFilePath,
    contents: `${JSON.stringify({ v: 1, descriptor })}\n`,
  });
  return Object.freeze({
    authorization: Object.freeze({
      capabilityHash: hashAgentRuntimeSessionBridgeToken(capability),
      descriptor,
      foregroundAdmissionFilePath,
      bootstrapFilePath,
      authorityFilePath,
    }),
    childEnv: Object.freeze({
      [HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY]:
        bootstrapFilePath,
      [HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY]:
        authorityFilePath,
    }),
    cleanupBootstrapFiles: async () => {
      await removePrivateBearerFile(
        foregroundAdmissionFilePath,
      ).catch(() => undefined);
      await removePrivateBearerFile(bootstrapFilePath).catch(() => undefined);
    },
  });
}
