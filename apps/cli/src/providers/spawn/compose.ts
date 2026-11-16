import { logProviderUnexpectedFailure } from '@/providers/diagnostics';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

import { cleanupRetainedProviderNativeHome, retainProviderNativeHome } from './nativeHomeLifetime';

import { AgentProviderBindingLaunchMaterializationV1Schema } from '@happier-dev/protocol/providers/materialization/v1';
import { AgentProviderBindingMaterializationV1Schema } from '@happier-dev/protocol/providers/materialization/v1';
import type { AgentProviderBindingLaunchMaterializationV1, AgentProviderBindingMaterializationV1, SessionEnvOverlayV1 } from '@happier-dev/protocol';
import type { ConnectedServiceStateSharingDescriptor } from '@/agent/catalog/types';
import { applyConnectedServiceStateSharingDescriptor, resolveConnectedServiceNativeHomeRoot } from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import { sessionProcessEnvironment, sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath';

export type ProviderBindingNativeHomeContext = Readonly<{
  descriptor: ConnectedServiceStateSharingDescriptor;
  sourceEnvironment?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
}>;

export type ComposedProviderBindingMaterialization = Readonly<{
  providerEnvironmentOverlay: SessionEnvOverlayV1;
  launchMaterialization: AgentProviderBindingLaunchMaterializationV1;
  additionalRedactionValues: readonly string[];
  cleanup: (() => void) | null;
  takeCleanupOwnership: () => (() => void) | null;
}>;

function writePrivateFile(path: string, contents: string): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, contents, { encoding: 'utf8' });
  } catch (error) {
    try { closeSync(descriptor); } catch (cleanupError) { logProviderUnexpectedFailure('launch', cleanupError); }
    throw error;
  }
  closeSync(descriptor);
}

function createJsonObjectOverlay(contents: string): (nativeContents: string) => string {
  const patch: unknown = JSON.parse(contents);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Provider binding JSON merge requires objects');
  }
  return (nativeContents) => {
    const existing: unknown = JSON.parse(nativeContents);
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      throw new Error('Provider binding JSON merge requires objects');
    }
    return JSON.stringify({ ...existing, ...patch });
  };
}

export function resolveProviderMaterializationParentPath(
  absolutePath: string,
  pathApi: Readonly<{ dirname: (path: string) => string }> = { dirname },
): string {
  return pathApi.dirname(absolutePath);
}

export function createProviderBindingLaunchMaterializationCleanup(
  input: Readonly<{
    materialization: AgentProviderBindingLaunchMaterializationV1;
    materializationBaseDir: string;
  }>,
): (() => void) | null {
  const materialization =
    AgentProviderBindingLaunchMaterializationV1Schema.parse(
      input.materialization,
    );
  if (materialization.kind !== 'configFile') return null;
  const base = resolve(input.materializationBaseDir);
  const root = resolve(materialization.rootPath);
  const child = relative(base, root);
  if (
    !child
    || child.startsWith('..')
    || isAbsolute(child)
    || dirname(root) !== base
    || !basename(root).startsWith('provider-binding-')
  ) {
    return null;
  }
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    let realBase: string;
    let realRoot: string;
    try {
      realBase = realpathSync(base);
      realRoot = realpathSync(root);
    } catch (error) {
      if (
        error instanceof Error
        && 'code' in error
        && error.code === 'ENOENT'
      ) {
        return;
      }
      throw error;
    }
    if (dirname(realRoot) !== realBase) return;
    if (!cleanupRetainedProviderNativeHome(root, realRoot)) rmSync(root, { recursive: true, force: true });
  };
}

export async function composeProviderBindingMaterialization(input: Readonly<{
  materialization: AgentProviderBindingMaterializationV1;
  materializationBaseDir: string;
  sessionId?: string;
  nativeHome?: ProviderBindingNativeHomeContext;
}>): Promise<ComposedProviderBindingMaterialization> {
  const materialization = AgentProviderBindingMaterializationV1Schema.parse(input.materialization);
  const additionalRedactionValues = Object.freeze([...(materialization.additionalRedactionValues ?? [])]);
  if (materialization.kind === 'spawnEnv') {
    return {
      providerEnvironmentOverlay: materialization.env,
      launchMaterialization: AgentProviderBindingLaunchMaterializationV1Schema.parse({ v: 1, kind: 'spawnEnv' }),
      additionalRedactionValues,
      cleanup: null,
      takeCleanupOwnership: () => null,
    };
  }
  if (materialization.kind === 'engineConfig') {
    return {
      providerEnvironmentOverlay: materialization.env,
      launchMaterialization: AgentProviderBindingLaunchMaterializationV1Schema.parse({
        v: 1,
        kind: 'engineConfig',
        engineConfig: materialization.engineConfig,
      }),
      additionalRedactionValues,
      cleanup: null,
      takeCleanupOwnership: () => null,
    };
  }

  mkdirSync(input.materializationBaseDir, { recursive: true, mode: 0o700 });
  const rootPath = mkdtempSync(join(input.materializationBaseDir, 'provider-binding-'));
  let nativeHomeRoot = rootPath;
  let launchMaterialization:
    AgentProviderBindingLaunchMaterializationV1;
  let physicalCleanup: () => void;
  try {
    launchMaterialization =
      AgentProviderBindingLaunchMaterializationV1Schema.parse({
        v: 1,
        kind: 'configFile',
        rootPath,
        relativePaths: materialization.files.map((file) => file.relativePath),
      });
    const resolvedCleanup =
      createProviderBindingLaunchMaterializationCleanup({
        materialization: launchMaterialization,
        materializationBaseDir: input.materializationBaseDir,
      });
    if (!resolvedCleanup) {
      throw new Error('Provider binding materialization cleanup is unavailable');
    }
    physicalCleanup = resolvedCleanup;
  } catch (error) {
    try { rmSync(rootPath, { recursive: true, force: true }); }
    catch (cleanupError) { logProviderUnexpectedFailure('launch', cleanupError); }
    throw error;
  }
  let cleanupOwner: 'generation' | 'retained_session' | 'cleaned' =
    'generation';
  const cleanup = () => {
    if (cleanupOwner !== 'generation') return;
    cleanupOwner = 'cleaned';
    physicalCleanup();
  };
  const takeCleanupOwnership = () => {
    if (cleanupOwner !== 'generation') return null;
    cleanupOwner = 'retained_session';
    return physicalCleanup;
  };
  try {
    let providerEnvironmentOverlay = materialization.env;
    const overlays = Object.fromEntries(materialization.files.filter(file => file.merge === 'jsonObject')
      .map(file => [file.relativePath.replaceAll('\\', '/'), createJsonObjectOverlay(file.utf8)]));
    let copiedConfigEntries: readonly string[] = [];
    if (materialization.nativeHome) {
      const context = input.nativeHome;
      const declaration = context?.descriptor.nativeHome;
      if (!context || !declaration) throw new Error('Provider binding native-home descriptor is unavailable');
      const sourceEnvironment = context.sourceEnvironment ?? sessionProcessEnvironment();
      const sourceRoot = resolveConnectedServiceNativeHomeRoot({ nativeHome: declaration,
        sourceEnvironment, homeDir: context.homeDir ?? resolveHomeDirFromEnvironment(sourceEnvironment) });
      if (input.sessionId && context.descriptor.state.entries.some(entry => entry.requiresRealDirectory)) {
        nativeHomeRoot = retainProviderNativeHome({
          generationRoot: rootPath, materializationBaseDir: input.materializationBaseDir,
          sessionId: input.sessionId, agentId: context.descriptor.providerId,
          configPaths: [...new Set([...materialization.files.map(file => file.relativePath),
            ...context.descriptor.config.entries.map(entry => entry.path)].map(path => path.replaceAll('\\', '/')))],
        });
      }
      const stateSharing = await applyConnectedServiceStateSharingDescriptor({
        descriptor: context.descriptor,
        nativeSourceContext: { sourceRoot, sourceEnv: Object.fromEntries(Object.entries(sourceEnvironment).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) },
        target: { targetMaterializedRoot: nativeHomeRoot, targetMaterializedEnv: { [declaration.environmentKey]: nativeHomeRoot } },
        configMode: context.descriptor.config.supported ? 'copied' : 'isolated',
        requestedStateMode: 'shared', effectiveStateMode: 'shared', cwd: sessionWorkingDirectory(),
        // Real directories already retained here are the native authority.
        // Import the user's history once; never overwrite later native writes
        // from an older source-home snapshot on replacement or resume.
        ...(nativeHomeRoot !== rootPath ? { stateEntryNames: context.descriptor.state.entries
          .filter(entry => !entry.requiresRealDirectory || !existsSync(join(nativeHomeRoot, entry.path)))
          .map(entry => entry.path) } : {}),
        copyTransformByEntry: overlays,
      });
      copiedConfigEntries = stateSharing.manifest.configEntries;
      const projected = { ...stateSharing.envOverrides, [declaration.environmentKey]: nativeHomeRoot };
      const projectedNames = new Set(Object.keys(projected).map(name => name.toUpperCase()));
      providerEnvironmentOverlay = [
        ...materialization.env.filter(entry => !projectedNames.has(entry.name.toUpperCase())),
        ...Object.entries(projected).map(([name, value]) => ({ name, value, source: 'provider' as const })),
      ];
    }
    for (const file of materialization.files) {
      // Merge while the canonical state-sharing owner copies the source rather
      // than reading our own private write back to reconstruct native settings.
      const relativePath = file.relativePath.replaceAll('\\', '/');
      if (file.merge === 'jsonObject' && copiedConfigEntries.includes(relativePath)) continue;
      const absolutePath = join(rootPath, ...file.relativePath.split(/[\\/]/u));
      const parentPath = resolveProviderMaterializationParentPath(absolutePath);
      mkdirSync(parentPath, { recursive: true, mode: 0o700 });
      // State-sharing may have created this private config parent earlier.
      // Native profiles such as FX ignore config unless its directory is 0700.
      if (process.platform !== 'win32') chmodSync(parentPath, 0o700);
      const contents = overlays[relativePath]?.('{}') ?? file.utf8;
      // Descriptor config copies belong to this private root. Replace only that
      // private destination; never write through a linked native source.
      rmSync(absolutePath, { force: true });
      writePrivateFile(absolutePath, contents);
    }
    return {
      providerEnvironmentOverlay,
      launchMaterialization,
      additionalRedactionValues,
      cleanup,
      takeCleanupOwnership,
    };
  } catch (error) {
    try { cleanup(); } catch (cleanupError) { logProviderUnexpectedFailure('launch', cleanupError); }
    throw error;
  }
}
