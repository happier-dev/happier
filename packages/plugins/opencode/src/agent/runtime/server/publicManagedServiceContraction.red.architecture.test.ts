import { access, readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const runtimeFile = (name: string) => new URL(name, import.meta.url);
const pluginSourceRoot = new URL('../../../', import.meta.url);
const privateManagedServerEndpointModules = [
  '@happier-dev/plugin-sdk/internal/managed-server-endpoint-projection',
  '@happier-dev/plugin-sdk/internal/managed-server-endpoint-projection-resolver',
] as const;

async function source(name: string): Promise<string> {
  return await readFile(runtimeFile(name), 'utf8');
}

async function productionSourceFiles(directory: URL): Promise<readonly URL[]> {
  const files: URL[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory);
    if (entry.isDirectory()) {
      files.push(...await productionSourceFiles(path));
      continue;
    }
    if (
      entry.isFile()
      && /\.(?:[cm]?[jt]sx?)$/u.test(entry.name)
      && !entry.name.endsWith('.d.ts')
      && !entry.name.includes('.test.')
      && !entry.name.includes('.spec.')
    ) {
      files.push(path);
    }
  }
  return files;
}

async function privateEndpointImportOffenders(): Promise<readonly string[]> {
  const offenders: string[] = [];
  for (const file of await productionSourceFiles(pluginSourceRoot)) {
    const contents = await readFile(file, 'utf8');
    for (const moduleSpecifier of privateManagedServerEndpointModules) {
      const importPattern = new RegExp(
        `\\b(?:from\\s+|import\\s*(?:\\(\\s*)?)["']${moduleSpecifier}["']`,
        'u',
      );
      if (importPattern.test(contents)) {
        offenders.push(
          `${moduleSpecifier}: ${decodeURIComponent(file.href.slice(pluginSourceRoot.href.length))}`,
        );
      }
    }
  }
  return offenders.sort();
}

describe('OpenCode public managed-service contraction after positive consumers', () => {
  it('keeps private endpoint projection modules out of production plugin leaves', async () => {
    await expect(privateEndpointImportOffenders()).resolves.toEqual([]);
  });

  it('removes local spec/handle and process-generation identity from the live runtime path', async () => {
    const [runtimeContext, assembly, transport, controller] = await Promise.all([
      source('./runtimeContext.ts'),
      source('./assembly.ts'),
      source('./transport.ts'),
      source('./runtimeController.ts'),
    ]);
    const liveRuntime = [runtimeContext, assembly, transport, controller].join('\n');

    for (const retiredSymbol of [
      'OpenCodeManagedServerSpec',
      'OpenCodeManagedServerHandle',
      'OpenCodeManagedServerSnapshot',
      'readOpenCodeManagedServerEndpointIdentity',
      'resolveOpenCodeManagedServerGenerationIdentity',
      'instanceId',
      'generationKey',
      'OpenCodeServerCredential',
      'createOpenCodeManagedServerCredential',
      'randomBytes',
      'Buffer.from',
      'globalThis.fetch',
      'assertManagedServiceCurrent',
      'normalizeBaseUrl',
      'isWithinBaseUrl',
    ]) {
      expect(liveRuntime, retiredSymbol).not.toContain(retiredSymbol);
    }
  });

  it('keeps endpoint.ts as endpoint selection only, without a private password or Basic header owner', async () => {
    const endpoint = await source('./endpoint.ts');
    for (const retiredSymbol of [
      "from 'node:buffer'",
      "from 'node:crypto'",
      'OpenCodeServerCredential',
      'createOpenCodeManagedServerCredential',
      'authorization:',
      'Basic ',
    ]) {
      expect(endpoint, retiredSymbol).not.toContain(retiredSymbol);
    }
    expect(endpoint).toContain("OPENCODE_SERVER_PASSWORD_ENV_KEY = 'OPENCODE_SERVER_PASSWORD'");
  });

  it('removes the old state-path, generation, PID and endpoint-claim graph', async () => {
    const [endpoint, externalClient, externalObservation] = await Promise.all([
      source('./endpoint.ts'),
      source('../../surfaces/sessions/external/client.ts'),
      source('../../surfaces/sessions/external/observation.ts'),
    ]);
    const endpointConsumers = [endpoint, externalClient, externalObservation].join('\n');

    for (const retiredSymbol of [
      'HAPPIER_MANAGED_SERVER_ENDPOINT_PROJECTION_ROOT_ENV_KEY',
      'ManagedServerEndpointProjectionV1',
      'projectionToken',
      'generationFingerprint',
      'launchIdentityFingerprint',
      '.pid',
      'managed_server.endpoint.read.claim',
    ]) {
      expect(endpointConsumers, retiredSymbol).not.toContain(retiredSymbol);
    }

    await expect(access(runtimeFile('./managedServerGeneration.ts'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('retains Connected Services selection identity only as an auth-isolation fact', async () => {
    const state = await source('./managedServerState.ts');
    expect(state).toContain('OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV');
    expect(state).not.toContain('OPENCODE_MANAGED_SERVER_STATE_PATH_ENV_KEY');
    expect(state).not.toContain('isOpenCodeManagedServerCommand');
  });
});
