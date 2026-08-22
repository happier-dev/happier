import {
  closeSync,
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

import {
  AgentProviderBindingLaunchMaterializationV1Schema,
  AgentProviderBindingMaterializationV1Schema,
  type AgentProviderBindingLaunchMaterializationV1,
  type AgentProviderBindingMaterializationV1,
  type SessionEnvOverlayV1,
} from '@happier-dev/protocol';

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
  } finally {
    closeSync(descriptor);
  }
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
    rmSync(root, { recursive: true, force: true });
  };
}

export async function composeProviderBindingMaterialization(input: Readonly<{
  materialization: AgentProviderBindingMaterializationV1;
  materializationBaseDir: string;
  sessionId?: string;
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
    rmSync(rootPath, { recursive: true, force: true });
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
    for (const file of materialization.files) {
      const absolutePath = join(rootPath, ...file.relativePath.split(/[\\/]/u));
      const parentPath = resolveProviderMaterializationParentPath(absolutePath);
      mkdirSync(parentPath, { recursive: true, mode: 0o700 });
      writePrivateFile(absolutePath, file.utf8);
    }
    return {
      providerEnvironmentOverlay: materialization.env,
      launchMaterialization,
      additionalRedactionValues,
      cleanup,
      takeCleanupOwnership,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
