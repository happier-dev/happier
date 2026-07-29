import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

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
    };
  }

  mkdirSync(input.materializationBaseDir, { recursive: true, mode: 0o700 });
  const rootPath = mkdtempSync(join(input.materializationBaseDir, 'provider-binding-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(rootPath, { recursive: true, force: true });
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
      launchMaterialization: AgentProviderBindingLaunchMaterializationV1Schema.parse({
        v: 1,
        kind: 'configFile',
        rootPath,
        relativePaths: materialization.files.map((file) => file.relativePath),
      }),
      additionalRedactionValues,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
