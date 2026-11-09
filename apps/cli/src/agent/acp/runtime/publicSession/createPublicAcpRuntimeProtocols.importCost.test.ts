import inspector from 'node:inspector';
import { createRequire } from 'node:module';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

import { projectPath } from '@/projectPath';
import { withTempDir } from '@/testkit/fs/tempDir';

it('loads the ACP SDK only when a registered protocol opens a real connection', async () => {
  const require = createRequire(join(projectPath(), 'package.json'));
  const sdkPath = require.resolve('@agentclientprotocol/sdk');
  const sdkUrl = pathToFileURL(sdkPath).href;
  const observation = new inspector.Session();
  observation.connect();
  const scripts: { url: string }[] = [];
  observation.on('Debugger.scriptParsed', ({ params }) => scripts.push(params));
  try {
    await new Promise<void>((resolve, reject) => observation.post('Debugger.enable', error => error ? reject(error) : resolve()));
    const sdkLoaded = () => scripts.some(({ url }) => url.split('?')[0] === sdkUrl || url.split('?')[0] === sdkPath);
    expect(sdkLoaded(), 'the isolated test must start with the SDK unloaded').toBe(false);
    const { createPublicAcpRuntimeProtocols } = await import('./createPublicAcpRuntimeProtocols');
    const { createUnavailablePluginServices } = await import('@/plugins/runtime/invocation/services/unavailable');
    const lifetime = new AbortController();
    const protocols = createPublicAcpRuntimeProtocols({
      pluginId: 'fixture', agentId: 'fixture', signal: lifetime.signal,
      isCurrent: () => !lifetime.signal.aborted, services: createUnavailablePluginServices(),
    });
    expect(sdkLoaded(), 'protocol registration must leave the SDK unloaded until an ACP operation').toBe(false);

    // Compile the real static closure using the existing import-cost harness.
    // First-use imports are separate work; source and domain logic stay real.
    const { build } = await import('esbuild');
    const compiled = await build({
      absWorkingDir: projectPath(),
      entryPoints: ['src/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols.ts'],
      bundle: true, format: 'esm', platform: 'node', packages: 'external',
      write: false, metafile: true,
      plugins: [{
        name: 'static-protocol-registration-closure',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, args => args.kind === 'dynamic-import'
            ? { path: args.path, external: true } : undefined);
        },
      }],
    });
    const inputs = Object.keys(compiled.metafile.inputs);
    const heavyInputs = inputs.filter(path => /agent\/acp\/(?:AcpBackend|connection\/|history\/acpHistoryExtensionMethods|runtime\/publicSession\/createPublicAcpSession)/u.test(path.replaceAll('\\', '/')));
    const sdkImports = Object.values(compiled.metafile.outputs)
      .flatMap(output => output.imports.filter(item => item.path === '@agentclientprotocol/sdk'));
    console.info('acp-protocol-static-closure', JSON.stringify({ staticModules: inputs.length, heavyInputs, sdkImports }));
    expect(heavyInputs).toEqual([]);
    expect(sdkImports).toEqual([]);

    await withTempDir('happier-acp-protocol-demand-', async cwd => {
      const requests: string[] = [];
      const sockets = new Set<Socket>();
      const server = createServer(socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        void (async () => {
          for await (const line of createInterface({ input: socket })) {
            const request = JSON.parse(line) as { id?: string | number; method?: string };
            if (request.id === undefined) continue;
            requests.push(request.method ?? '');
            const result = request.method === 'initialize'
              ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
              : request.method === 'session/new' ? { sessionId: 'fixture-native-session' } : {};
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
          }
        })().catch(() => socket.destroy());
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      let runtime: Awaited<ReturnType<typeof protocols.acp.open>> | undefined;
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected TCP address');
        runtime = await protocols.acp.open({ kind: 'create', sessionId: 'fixture-session', cwd },
          { transport: { kind: 'tcp', host: '127.0.0.1', port: address.port } });
        expect(sdkLoaded(), 'a real ACP operation must evaluate the SDK').toBe(true);
        expect(requests).toEqual(['initialize', 'session/new']);
      } finally {
        try {
          await runtime?.dispose();
        } finally {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          lifetime.abort();
        }
      }
    });
  } finally {
    observation.disconnect();
  }
}, 120_000);
