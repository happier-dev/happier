import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import {
  expandHomePath,
  isCanonicalAbsolutePathInsideRoot,
  resolveHomeDirFromEnvironment,
  withExclusiveFileLock,
} from '@happier-dev/plugin-sdk/fs';

import { collectCodexSessionRolloutFiles } from '../../../rollout/discovery/sessionsForHome.js';
import {
  buildCodexAgentRuntimeDescriptor,
  normalizeCodexBackendMode,
  readCanonicalCodexAgentRuntimeDescriptorV1,
} from '../../../../protocol/runtimeDescriptorV1.js';
import type {
  CodexSessionHandoffBundle,
  ImportedCodexSessionHandoffBundle,
} from './bundle.js';
import {
  CodexSessionHandoffBundleSchema,
  normalizeCodexHandoffBundleRelativePath,
} from './bundle.js';
import {
  CodexExternalSessionHandoffSourceSchema,
  type CodexExternalSessionHandoffSource,
  type CodexExternalSessionSource,
} from '../external/models.js';

function parseCodexExternalSessionHandoffSource(source: unknown): CodexExternalSessionHandoffSource | null {
  const parsedSource = CodexExternalSessionHandoffSourceSchema.safeParse(source);
  return parsedSource.success ? parsedSource.data : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeLegacyCodexHandoffBundle(bundle: unknown): unknown {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return bundle;
  const affinity = (bundle as { affinity?: unknown }).affinity;
  if (!affinity || typeof affinity !== 'object' || Array.isArray(affinity)) return bundle;
  if ((affinity as { backendMode?: unknown }).backendMode !== 'mcp') return bundle;

  // Historical handoff bundles named the app-server runtime "mcp".
  return {
    ...bundle,
    affinity: { ...affinity, backendMode: 'appServer' },
  };
}

function resolveCodexRuntimeSourceAffinity(source: unknown): Readonly<{
  home?: 'user' | 'connectedService';
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  connectedServiceGroupId?: string;
}> {
  const parsedSource = parseCodexExternalSessionHandoffSource(source);
  if (!parsedSource || parsedSource.kind !== 'codexHome') {
    return {};
  }

  return parsedSource.home === 'connectedService'
    ? {
      home: 'connectedService',
      connectedServiceId: optionalString(parsedSource.connectedServiceId),
      connectedServiceProfileId: optionalString(parsedSource.connectedServiceProfileId),
      connectedServiceGroupId: optionalString(parsedSource.connectedServiceGroupId),
    }
    : { home: 'user' };
}

function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  const raw = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  const homeDir = resolveHomeDirFromEnvironment(env);
  return raw ? expandHomePath(raw, homeDir) : join(homeDir, '.codex');
}

function resolveContainedCodexPath(codexHome: string, relativePath: string): string {
  const root = resolve(codexHome);
  const candidate = resolve(root, relativePath);
  if (!isCanonicalAbsolutePathInsideRoot(root, candidate)) {
    throw new Error(`Codex bundle path escapes CODEX_HOME: ${relativePath}`);
  }
  return candidate;
}

type PreparedCodexImportFile = Readonly<{
  relativePath: string;
  destinationPath: string;
  content: Buffer;
}>;

const CODEX_NATIVE_SESSION_IMPORT_LOCK_TIMEOUT_MS = 15_000;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Codex handoff import was cancelled');
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function targetIdentityConflict(relativePath: string, reason: string, cause?: unknown): PluginError {
  return new PluginError({
    code: 'target_identity_conflict',
    message: `Codex handoff target conflicts at ${relativePath}: ${reason}`,
    retryable: false,
  }, cause === undefined ? undefined : { cause });
}

function prepareCodexImportFiles(
  codexHome: string,
  files: CodexSessionHandoffBundle['files'],
): readonly PreparedCodexImportFile[] {
  const filesByDestination = new Map<string, PreparedCodexImportFile>();

  for (const file of files) {
    const relativePath = normalizeCodexHandoffBundleRelativePath(file.relativePath);
    const prepared = {
      relativePath,
      destinationPath: resolveContainedCodexPath(codexHome, relativePath),
      content: Buffer.from(file.contentBase64, 'base64'),
    } satisfies PreparedCodexImportFile;
    const previous = filesByDestination.get(prepared.destinationPath);
    if (previous) {
      if (!previous.content.equals(prepared.content)) {
        throw targetIdentityConflict(relativePath, 'the bundle contains divergent content for one destination');
      }
      continue;
    }
    filesByDestination.set(prepared.destinationPath, prepared);
  }

  return [...filesByDestination.values()];
}

async function withCodexNativeSessionImportCriticalSection<TResult>(
  codexHome: string,
  remoteSessionId: string,
  signal: AbortSignal | undefined,
  effect: (physicalCodexHome: string) => Promise<TResult>,
): Promise<TResult> {
  throwIfAborted(signal);
  await mkdir(codexHome, { recursive: true });
  throwIfAborted(signal);
  const physicalCodexHome = await realpath(codexHome);
  throwIfAborted(signal);
  const sessionKey = createHash('sha256').update(remoteSessionId, 'utf8').digest('hex');
  const lockPath = join(
    physicalCodexHome,
    '.happier',
    'locks',
    'native-session-import-v1',
    `${sessionKey}.lock`,
  );
  return await withExclusiveFileLock({
    lockPath,
    timeoutMs: CODEX_NATIVE_SESSION_IMPORT_LOCK_TIMEOUT_MS,
  }, async () => {
    throwIfAborted(signal);
    const result = await effect(physicalCodexHome);
    throwIfAborted(signal);
    return result;
  });
}

async function assertExistingCodexNativeSessionBelongsToBundle(
  codexHome: string,
  remoteSessionId: string,
  preparedFiles: readonly PreparedCodexImportFile[],
): Promise<void> {
  const preparedDestinations = new Set(preparedFiles.map((file) => file.destinationPath));
  const existingRollouts = await collectCodexSessionRolloutFiles({
    codexHome,
    remoteSessionId,
  });
  for (const rollout of existingRollouts) {
    if (!preparedDestinations.has(resolve(rollout.filePath))) {
      throw targetIdentityConflict(
        rollout.fileRelPath,
        'the native session already contains a rollout outside this bundle',
      );
    }
  }
}

async function assertExistingParentDirectoriesAreSafe(
  codexHome: string,
  file: PreparedCodexImportFile,
): Promise<void> {
  const parentRelativePath = relative(resolve(codexHome), dirname(file.destinationPath));
  if (!parentRelativePath) return;

  let currentPath = resolve(codexHome);
  for (const segment of parentRelativePath.split(sep)) {
    if (!segment) continue;
    currentPath = join(currentPath, segment);
    try {
      const entry = await lstat(currentPath);
      if (!entry.isDirectory()) {
        throw targetIdentityConflict(file.relativePath, 'an existing parent is not a directory');
      }
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) {
        return;
      }
      if (isPluginError(error)) throw error;
      throw targetIdentityConflict(file.relativePath, 'an existing parent could not be verified safely', error);
    }
  }
}

async function inspectCodexImportDestination(
  codexHome: string,
  file: PreparedCodexImportFile,
): Promise<'identical' | 'missing'> {
  await assertExistingParentDirectoriesAreSafe(codexHome, file);

  let entry;
  try {
    entry = await lstat(file.destinationPath);
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) {
      return 'missing';
    }
    throw targetIdentityConflict(file.relativePath, 'the destination identity could not be inspected safely', error);
  }
  if (!entry.isFile()) {
    throw targetIdentityConflict(file.relativePath, 'the existing destination is not a regular file');
  }

  let existingContent: Buffer;
  try {
    existingContent = await readFile(file.destinationPath);
  } catch (error) {
    throw targetIdentityConflict(file.relativePath, 'the existing destination could not be compared safely', error);
  }
  if (!existingContent.equals(file.content)) {
    throw targetIdentityConflict(file.relativePath, 'the existing file has divergent content');
  }
  return 'identical';
}

async function createMissingCodexImportFile(
  codexHome: string,
  file: PreparedCodexImportFile,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  await mkdir(dirname(file.destinationPath), { recursive: true });
  throwIfAborted(signal);
  try {
    throwIfAborted(signal);
    await writeFile(file.destinationPath, file.content, { flag: 'wx' });
    throwIfAborted(signal);
  } catch (error) {
    if (!isNodeErrorWithCode(error, 'EEXIST')) throw error;

    const racedState = await inspectCodexImportDestination(codexHome, file);
    if (racedState !== 'identical') {
      throw targetIdentityConflict(file.relativePath, 'the destination changed during exclusive creation');
    }
  }
}

export async function importCodexSessionBundle(params: Readonly<{
  bundle: unknown;
  targetPath: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>): Promise<ImportedCodexSessionHandoffBundle> {
  throwIfAborted(params.signal);
  const bundle = CodexSessionHandoffBundleSchema.parse(normalizeLegacyCodexHandoffBundle(params.bundle)) as CodexSessionHandoffBundle;
  const codexHome = resolveCodexHome(params.env);
  const runtimeBackendMode = normalizeCodexBackendMode(bundle.affinity?.backendMode) ?? 'appServer';
  const importedRuntimeDescriptor = readCanonicalCodexAgentRuntimeDescriptorV1(bundle.affinity?.runtimeDescriptor);
  const sourceAffinity = resolveCodexRuntimeSourceAffinity(bundle.affinity?.source);
  const runtimeDescriptor = importedRuntimeDescriptor
    ? buildCodexAgentRuntimeDescriptor({
      backendMode: importedRuntimeDescriptor.backendMode ?? runtimeBackendMode,
      providerSessionId: importedRuntimeDescriptor.providerSessionId,
      home: importedRuntimeDescriptor.home,
      connectedServiceId: importedRuntimeDescriptor.connectedServiceId,
      connectedServiceProfileId: importedRuntimeDescriptor.connectedServiceProfileId,
      connectedServiceGroupId: importedRuntimeDescriptor.connectedServiceGroupId,
      // Handoff bundles must be portable across machines; never import a source-machine homePath.
      // Rollout files are written into the *target* CODEX_HOME below, so the runtime must use that.
      homePath: codexHome,
    })
    : buildCodexAgentRuntimeDescriptor({
      backendMode: runtimeBackendMode,
      providerSessionId: bundle.remoteSessionId,
      ...sourceAffinity,
      homePath: codexHome,
    });
  let externalSource: CodexExternalSessionSource;
  if (runtimeDescriptor.agent.home === 'connectedService') {
    externalSource = {
      kind: 'codexHome' as const,
      home: 'connectedService' as const,
      ...(runtimeDescriptor.agent.connectedServiceId ? { connectedServiceId: runtimeDescriptor.agent.connectedServiceId } : {}),
      ...(runtimeDescriptor.agent.connectedServiceProfileId ? { connectedServiceProfileId: runtimeDescriptor.agent.connectedServiceProfileId } : {}),
      ...(runtimeDescriptor.agent.connectedServiceGroupId ? { connectedServiceGroupId: runtimeDescriptor.agent.connectedServiceGroupId } : {}),
      // Intentionally omit any homePath: connected-service homes are resolved/verified per-machine.
    };
  } else {
    externalSource = {
      kind: 'codexHome' as const,
      home: 'user' as const,
      homePath: codexHome,
    };
  }
  await withCodexNativeSessionImportCriticalSection(
    codexHome,
    bundle.remoteSessionId,
    params.signal,
    async (physicalCodexHome) => {
      const preparedFiles = prepareCodexImportFiles(physicalCodexHome, bundle.files);
      throwIfAborted(params.signal);
      await assertExistingCodexNativeSessionBelongsToBundle(
        physicalCodexHome,
        bundle.remoteSessionId,
        preparedFiles,
      );
      throwIfAborted(params.signal);
      const destinationStates = await Promise.all(
        preparedFiles.map(async (file) => ({
          file,
          state: await inspectCodexImportDestination(physicalCodexHome, file),
        })),
      );
      throwIfAborted(params.signal);
      for (const destination of destinationStates) {
        throwIfAborted(params.signal);
        if (destination.state === 'missing') {
          await createMissingCodexImportFile(physicalCodexHome, destination.file, params.signal);
        }
        throwIfAborted(params.signal);
      }
      await assertExistingCodexNativeSessionBelongsToBundle(
        physicalCodexHome,
        bundle.remoteSessionId,
        preparedFiles,
      );
      throwIfAborted(params.signal);
      for (const file of preparedFiles) {
        throwIfAborted(params.signal);
        if (await inspectCodexImportDestination(physicalCodexHome, file) !== 'identical') {
          throw targetIdentityConflict(
            file.relativePath,
            'the destination disappeared during final verification',
          );
        }
        throwIfAborted(params.signal);
      }
    }
  );
  throwIfAborted(params.signal);

  return {
    remoteSessionId: bundle.remoteSessionId,
    externalSource,
    runtimeDescriptorV1: runtimeDescriptor,
    resume: {
      directory: params.targetPath,
      environmentVariables: { CODEX_HOME: codexHome },
      resumePlanOptions: { codexBackendMode: runtimeBackendMode },
    },
  };
}
