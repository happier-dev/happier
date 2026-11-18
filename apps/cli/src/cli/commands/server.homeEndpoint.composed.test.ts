import { createServer } from 'node:http';
import type { SpawnOptions } from 'child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration, reloadConfiguration } from '@/configuration';
import { writeCredentialsTokenOnlyForServerId } from '@/persistence';
import { adoptServerProfileHomeConnectionDescriptor, getServerProfile, setServerProfileEndpointsById } from '@/server/serverProfiles';
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { createFileHomeConnectionDescriptorContinuityStore, createHomeConnectionDescriptorContentKey } from '../../../../server/sources/app/features/homeConnectionDescriptorContinuity';
import { readHomeConnectionDescriptor, resetHomeConnectionDescriptorRevisionOwnerForTests } from '../../../../server/sources/app/features/homeConnectionDescriptorPublication';
import { handleServerCommand } from './server';

const launches = vi.hoisted(() => [] as Array<Readonly<{ args: readonly string[]; env: NodeJS.ProcessEnv | undefined }>>);

// Only process creation is replaced: publication, disk continuity, HTTP,
// authenticated observation, profile admission and launch resolution stay real.
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[] | SpawnOptions = [], options?: SpawnOptions) => {
      if (!Array.isArray(args)) return actual.spawn(command, args);
      if (!args.includes('start-sync')) return actual.spawn(command, args, options ?? {});
      launches.push({ args, env: options?.env });
      return new actual.ChildProcess();
    },
  };
});

describe('Home endpoint publication → server set → daemon launch', () => {
  afterEach(() => {
    launches.length = 0;
    resetHomeConnectionDescriptorRevisionOwnerForTests();
  });

  it.each(['port-move', 'lost-continuity', 'other-home', 'conflicting-revision'] as const)(
    'preserves Home authority through %s', async scenario => {
      await withTempDir('happier-home-endpoint-', async homeDir => {
        const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL',
          'HAPPIER_WEBAPP_URL', 'HAPPIER_CLI_SUBPROCESS_PREFER_TSX', 'DBUS_SESSION_BUS_ADDRESS']);
        const previousExitCode = process.exitCode;
        const output = captureConsoleLogAndMuteStdout();
        const server = createServer();
        try {
          scope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
            HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined,
            HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '1', DBUS_SESSION_BUS_ADDRESS: undefined });
          reloadConfiguration();
          resetHomeConnectionDescriptorRevisionOwnerForTests();
          const id = 'moved-home';
          const oldOrigin = 'http://localhost:3023';
          const oldDescriptor = { v: 1 as const, homeServerIdentityId: 'srv_port_move', canonicalServerUrl: oldOrigin,
            revision: 64, endpoints: [{ kind: 'https' as const, url: oldOrigin }] };
          await setServerProfileEndpointsById({ id, serverUrl: oldOrigin, webappUrl: oldOrigin, use: true });
          await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: id, descriptor: oldDescriptor, observation: 'exact' });
          await writeCredentialsTokenOnlyForServerId(id, { token: 'fixture-endpoint-token' });
          reloadConfiguration();
          const continuityStore = createFileHomeConnectionDescriptorContinuityStore(join(homeDir, 'runtime', 'home.descriptor.json'));
          // The live failure retained revision 64 in the client but started a
          // private publisher history at 1. A normal move retains the frontier.
          await continuityStore.write({ revision: scenario === 'lost-continuity' ? 1
            : scenario === 'conflicting-revision' ? 63 : 64,
          contentKey: createHomeConnectionDescriptorContentKey(oldDescriptor) });
          await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('Missing HTTP test address');
          const newOrigin = `http://127.0.0.1:${address.port}`;
          const publish = () => readHomeConnectionDescriptor({
            env: { HAPPIER_SERVER_IDENTITY_ID: scenario === 'other-home' ? 'srv_other_home' : oldDescriptor.homeServerIdentityId,
              HAPPIER_CANONICAL_SERVER_URL: newOrigin, HAPPIER_PUBLIC_SERVER_URL: newOrigin },
            continuityStore, visibility: 'authenticated',
            resolveIrohEndpointState: () => ({ status: 'not-composed', snapshot: null, failureReason: null }),
          });
          let published = await publish();
          expect(published).toBeDefined();
          expect((await continuityStore.read())?.revision).toBe(published?.revision);
          server.on('request', (request, response) => {
            if (request.url !== '/v1/features/authenticated' || request.headers.authorization !== 'Bearer fixture-endpoint-token') {
              response.writeHead(401).end();
              return;
            }
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ features: {}, capabilities: { serverIdentity: {
              serverIdentityId: published?.homeServerIdentityId } }, homeConnectionDescriptor: published }));
          });
          await handleServerCommand(['set', '--server-id', id, '--server-url', newOrigin,
            '--local-server-url', newOrigin, '--webapp-url', newOrigin, '--json']);
          const result = JSON.parse(output.logs.join('\n'));
          if (scenario === 'port-move') {
            expect(result).toMatchObject({ ok: true, kind: 'server_set' });
            expect(published?.revision).toBe(65);
            expect((await getServerProfile(id)).homeConnectionDescriptor).toEqual(published);
            expect(configuration.serverUrl).toBe(newOrigin);
            await spawnDetachedDaemonStartSync();
            expect(launches).toMatchObject([{ args: expect.arrayContaining(['daemon', 'start-sync']),
              env: { HAPPIER_HOME_DIR: homeDir } }]);
          } else {
            expect(result).toMatchObject({ ok: false, kind: 'server_set', error: {
              code: scenario === 'lost-continuity' ? 'stale_home_descriptor'
                : scenario === 'other-home' ? 'identity_mismatch' : 'home_descriptor_conflict',
            } });
            expect(process.exitCode).toBe(1);
            expect((await getServerProfile(id)).homeConnectionDescriptor).toEqual(oldDescriptor);
            expect(configuration.serverUrl).toBe(oldOrigin);
            expect(launches).toEqual([]);
            if (scenario === 'lost-continuity') {
              // Simulate the orchestrator's stopped-server recovery from the
              // verified retained record, without lowering the client's frontier.
              await continuityStore.write({ revision: oldDescriptor.revision,
                contentKey: createHomeConnectionDescriptorContentKey(oldDescriptor) });
              resetHomeConnectionDescriptorRevisionOwnerForTests();
              published = await publish();
              expect(published?.revision).toBe(65);
              output.logs.length = 0;
              await handleServerCommand(['set', '--server-id', id, '--server-url', newOrigin,
                '--local-server-url', newOrigin, '--webapp-url', newOrigin, '--json']);
              expect(JSON.parse(output.logs.join('\n'))).toMatchObject({ ok: true, kind: 'server_set' });
              expect((await getServerProfile(id)).homeConnectionDescriptor).toEqual(published);
              expect(configuration.serverUrl).toBe(newOrigin);
              await spawnDetachedDaemonStartSync();
              expect(launches).toMatchObject([{ args: expect.arrayContaining(['daemon', 'start-sync']),
                env: { HAPPIER_HOME_DIR: homeDir } }]);
            }
          }
        } finally {
          if (server.listening) {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          }
          output.restore();
          process.exitCode = previousExitCode;
          scope.restore();
          reloadConfiguration();
        }
      });
    },
  );

  // A shared-database Stack server mints its own Home identity record while the Stack's profile
  // still names the shared identity it established earlier. The Stack's profile reconciliation
  // re-establishes only onto the identity its own server recorded; a record naming any other
  // Home leaves the established descriptor in place.
  it.each(['own-record', 'foreign-record', 'malformed-record'] as const)('re-establishes a Stack profile only on its own server identity record (%s)', async scenario => {
    await withTempDir('happier-home-identity-record-', async homeDir => {
      const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL',
        'HAPPIER_WEBAPP_URL', 'HAPPIER_CLI_SUBPROCESS_PREFER_TSX', 'DBUS_SESSION_BUS_ADDRESS']);
      const previousExitCode = process.exitCode;
      const output = captureConsoleLogAndMuteStdout();
      const server = createServer();
      try {
        scope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
          HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined,
          HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '1', DBUS_SESSION_BUS_ADDRESS: undefined });
        reloadConfiguration();
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing HTTP test address');
        const origin = `http://127.0.0.1:${address.port}`;
        const id = 'stack_qa__id_default';
        const sharedDescriptor = { v: 1 as const, homeServerIdentityId: 'srv_shared_source', canonicalServerUrl: origin,
          revision: 66, endpoints: [{ kind: 'https' as const, url: origin }] };
        await setServerProfileEndpointsById({ id, serverUrl: origin, webappUrl: origin, use: true });
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: id, descriptor: sharedDescriptor, observation: 'exact' });
        await writeCredentialsTokenOnlyForServerId(id, { token: 'fixture-endpoint-token' });
        reloadConfiguration();
        const minted = 'srv_stack_own_minted';
        const published = await readHomeConnectionDescriptor({
          env: { HAPPIER_SERVER_IDENTITY_ID: minted, HAPPIER_CANONICAL_SERVER_URL: origin, HAPPIER_PUBLIC_SERVER_URL: origin },
          continuityStore: createFileHomeConnectionDescriptorContinuityStore(join(homeDir, 'server-light', 'runtime', 'home.descriptor.json')),
          visibility: 'authenticated',
          resolveIrohEndpointState: () => ({ status: 'not-composed', snapshot: null, failureReason: null }),
        });
        expect(published?.homeServerIdentityId).toBe(minted);
        let requests = 0;
        server.on('request', (request, response) => {
          requests += 1;
          if (request.url !== '/v1/features/authenticated' || request.headers.authorization !== 'Bearer fixture-endpoint-token') {
            response.writeHead(401).end();
            return;
          }
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: minted } },
            homeConnectionDescriptor: published }));
        });
        const recordPath = join(homeDir, 'server-light', 'runtime', 'server.identity');
        await mkdir(dirname(recordPath), { recursive: true });
        await writeFile(recordPath, `${{ 'own-record': minted, 'foreign-record': 'srv_some_other_home',
          'malformed-record': 'not-a-home-identity' }[scenario]}\n`);

        await handleServerCommand(['set', '--server-id', id, '--server-url', origin, '--local-server-url', origin,
          '--webapp-url', origin, '--home-identity-record', recordPath, '--json']);
        const result = JSON.parse(output.logs.join('\n'));
        if (scenario === 'own-record') {
          expect(result).toMatchObject({ ok: true, kind: 'server_set' });
          expect((await getServerProfile(id)).homeConnectionDescriptor).toEqual(published);
          await spawnDetachedDaemonStartSync();
          expect(launches).toMatchObject([{ args: expect.arrayContaining(['daemon', 'start-sync']) }]);
        } else {
          expect(result).toMatchObject({ ok: false, kind: 'server_set' });
          expect(process.exitCode).toBe(1);
          expect((await getServerProfile(id)).homeConnectionDescriptor).toEqual(sharedDescriptor);
          expect(launches).toEqual([]);
          // A record the server could never have written is refused before any Home is asked.
          if (scenario === 'malformed-record') {
            expect(result.error.code).toBe('server_identity_unavailable');
            expect(requests).toBe(0);
          }
        }
      } finally {
        if (server.listening) {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
        output.restore();
        process.exitCode = previousExitCode;
        scope.restore();
        reloadConfiguration();
      }
    });
  });
});
