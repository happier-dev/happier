import { chmodSync, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileEventually, writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createNativeAgentSessionPublications } from './engineRegistry/nativeAgentSessionPublications';
import { createNativeAgentSessionWorkStateService } from './engineRegistry/nativeAgentSessionWorkState';
import { createNativeAgentSessionHostServiceOwners } from './engineRegistry/nativeAgentSessionHostServiceOwners';
import { composeNativeAgentSessionRuntimeContext, createNativeAgentSessionHostServices } from './engineRegistry/nativeAgentSession';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';
import { createPublicAcpRuntimeProtocols } from '@/agent/acp/runtime/publicSession/createPublicAcpRuntimeProtocols';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createSessionScopedSocketConnection } from '@/api/session/sockets';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';
import { createResolvedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '../../../plugins/projection/registry/resolveBuiltInContributions';
import { createPluginInvocationPresentation } from '../../../plugins/runtime/invocation/services/interactions';

const { socketIo } = vi.hoisted(() => ({ socketIo: vi.fn() }));
// Only the remote HTTP and Socket.IO transports are replaced; Session state and
// every required host service use their current canonical owners.
vi.mock('socket.io-client', () => ({ io: socketIo }));
vi.mock('axios');

const PI_AGENT_ID = 'pi';
const PI_PLUGIN_ID = 'happier.agent.pi';

const PI_REQUEST_AUTH_CAPABILITY_PATH_ENV =
  'HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH';
const PI_REQUEST_AUTH_PRODUCER_VERSION_ENV =
  'HAPPIER_PI_REQUEST_AUTH_PRODUCER_VERSION';

function createPiContributionRegistry() {
  // Pi's declared cross-plugin account references resolve against the actual
  // generated catalog; executable activation remains scoped to Pi below.
  return createResolvedContributionRegistry(resolveBuiltInContributions());
}

const VERSION_CASES = [
  { version: '0.74.2', supported: false, reason: 'version_too_old' },
  { version: '0.80.10', supported: false, reason: 'version_too_old' },
  { version: '0.81.0', supported: true, reason: null },
] as const;

describe('engineRegistry (Pi request-auth compatibility)', () => {
  beforeEach(() => {
    socketIo.mockReset().mockImplementation(() => createApiSessionSocketStub());
    vi.mocked(axios.get).mockReset().mockResolvedValue({ status: 404, data: {} });
  });
  it.each(VERSION_CASES)(
    'uses the packaged Pi executable version $version to decide connected request-auth admission',
    async ({ version, supported, reason }) => {
      await withTempDir(`happier-pi-request-auth-${version.replaceAll('.', '-')}-`, async (directory) => {
        const probeCapturePath = join(directory, 'pi-version-probe.json');
        const runtimeCapturePath = join(directory, 'pi-runtime.json');
        const agentSource = `
          const { writeFileSync } = require('node:fs');

          const version = ${JSON.stringify(version)};
          if (process.argv.includes('--version')) {
            writeFileSync(${JSON.stringify(probeCapturePath)}, JSON.stringify({
              args: process.argv.slice(2),
              version,
            }));
            process.stdout.write('@earendil-works/pi-coding-agent ' + version + '\\n');
            process.exit(0);
          }

          writeFileSync(${JSON.stringify(runtimeCapturePath)}, JSON.stringify({
            args: process.argv.slice(2),
            producerVersion: process.env[${JSON.stringify(PI_REQUEST_AUTH_PRODUCER_VERSION_ENV)}] ?? null,
          }));
          const decoder = new TextDecoder();
          let buffer = '';
          const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
          process.stdin.on('data', (chunk) => {
            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split('\\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              const request = JSON.parse(line);
              send({
                type: 'response',
                id: request.id,
                command: request.type,
                success: true,
                ...(request.type === 'get_state'
                  ? { data: { sessionId: 'provider-pi-request-auth-${version}' } }
                  : {}),
              });
            }
          });
        `;
        const agentScriptPath = writeAcpTestAgentScript({
          dir: directory,
          fileName: 'pi-agent.cjs',
          source: agentSource,
        });
        const systemToolExecutablePath = process.platform === 'win32'
          ? writeAcpTestAgentScript({
              dir: directory,
              fileName: 'pi.cmd',
              source: `@echo off\r\n"${process.execPath}" "${agentScriptPath}" %*\r\n`,
            })
          : writeAcpTestAgentScript({
              dir: directory,
              fileName: 'pi',
              source: `#!${process.execPath}\n${agentSource}`,
            });
        chmodSync(systemToolExecutablePath, 0o755);

        const envScope = createEnvKeyScope(['PATH']);
        envScope.patch({ PATH: `${directory}${delimiter}${process.env.PATH ?? ''}` });
        let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
        let publications: ReturnType<typeof createNativeAgentSessionPublications> | null = null;
        let hostSession: ApiSessionClient | null = null;
        let hostOwners: ReturnType<typeof createNativeAgentSessionHostServiceOwners> | null = null;
        try {
          fixture = await createAdmittedPluginRuntimeFixture({
            happyHomeDir: join(directory, 'home'),
            runtimeOptions: {
              contributes: createPiContributionRegistry(),
              pluginIds: [PI_PLUGIN_ID],
            },
          });
          const runtimeRegistry = fixture.registry;
          const declaredPi = runtimeRegistry.contributes.agentDefinitionsById.get(PI_AGENT_ID);
          const processAccess = declaredPi?.hostAccess?.required.find(
            (request) => request.capability === 'process',
          );
          expect(processAccess?.scope.envKeys).toContain(PI_REQUEST_AUTH_PRODUCER_VERSION_ENV);
          const lease = runtimeRegistry.agentRuntimesByAgentId.get(PI_AGENT_ID);
          if (!lease?.hasPrimaryRuntime) {
            throw new Error('Expected the activated Pi primary runtime lease');
          }
          const signal = new AbortController().signal;
          const launchEnvironment = {
            PI_CODING_AGENT_DIR: directory,
            [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: join(directory, 'request-auth-capability.json'),
          };
          const services = await runtimeRegistry.createAgentInvocationServices({
            pluginId: PI_PLUGIN_ID,
            pluginVersion: lease.pluginVersion,
            agentId: PI_AGENT_ID,
            occurrenceId: lease.occurrenceId,
            correlationId: `pi-request-auth-${version}`,
            cwd: directory,
            environment: launchEnvironment,
            signal,
            isOccurrenceCurrent: lease.isCurrent,
          });
          const runtime = await lease.createRuntime({ signal });
          const sessions = runtime.sessions;
          if (!sessions) {
            throw new Error('Expected Pi to expose its declared session runtime');
          }
          const sessionId = `host-pi-request-auth-${version}`;
          const token = 'pi-request-auth-session-token';
          const serverUrl = 'https://pi-request-auth.example.test';
          hostSession = new ApiSessionClient(token, createPlainSessionFixture({ id: sessionId }), {
            metadataAuthority: { kind: 'shared_editor' },
            durableMutationDeliveryInitiallyActive: false,
            transport: {
              serverId: 'pi-request-auth-home',
              serverUrl,
              createSessionSocketTransport: ({ sessionId, machineId }) => createSessionScopedSocketConnection({
                token, sessionId, machineId, serverUrl,
              }),
            },
          });
          const resolution = await resolveBackendEngineAdapterResolution(PI_AGENT_ID, { runtimeRegistry });
          if (!resolution) throw new Error('Expected the admitted Pi engine resolution');
          hostOwners = createNativeAgentSessionHostServiceOwners({
            runtimeRegistry,
            identity: {
              pluginId: PI_PLUGIN_ID, agentId: PI_AGENT_ID,
              pluginVersion: lease.pluginVersion, occurrenceId: lease.occurrenceId,
              isCurrent: lease.isCurrent,
            },
            backend: resolution.backend,
            agent: resolution.agent,
            hostSession: {
              session: hostSession, machineId: 'pi-request-auth-machine',
              accountSettingsAuthority: 'session',
              permissionHandler: new ProviderEnforcedPermissionHandler(hostSession, { logPrefix: 'Pi request-auth fixture' }),
            },
            sessionId, directory, signal, happyHomeDir: fixture.happyHomeDir,
          });
          publications = createNativeAgentSessionPublications({
            agentId: PI_AGENT_ID,
            session: hostSession,
            signal,
            isCurrent: lease.isCurrent,
            supportsInFlightSteer: false,
          });
          const sessionServices = createNativeAgentSessionHostServices({
            owners: hostOwners, agentId: PI_AGENT_ID, sessionId, directory, signal,
            isCurrent: lease.isCurrent, session: hostSession,
            publications: publications.services,
            readToolExecutionCapability: () => runtime.toolExecution?.capability ?? null,
          });
          const context = composeNativeAgentSessionRuntimeContext({
            identity: { pluginId: PI_PLUGIN_ID, pluginVersion: lease.pluginVersion, agentId: PI_AGENT_ID },
            contributionId: PI_AGENT_ID,
            sessionId,
            invokedAtMs: Date.now(),
            signal,
            services,
            ui: createPluginInvocationPresentation({
              currentSession: null,
              signal,
              isOccurrenceCurrent: () => true,
            }),
            protocols: createPublicAcpRuntimeProtocols({
              pluginId: PI_PLUGIN_ID, agentId: PI_AGENT_ID, signal,
              isCurrent: lease.isCurrent, services, models: sessionServices.models,
            }),
            sessionServices,
            workState: createNativeAgentSessionWorkStateService({
              session: hostSession,
              pluginId: PI_PLUGIN_ID,
              contributionId: PI_AGENT_ID,
              agentId: PI_AGENT_ID,
              occurrenceId: lease.occurrenceId,
              declarations: readAgentSessionCapabilities(declaredPi?.richDefinition?.definition)?.workStateSources ?? [],
              isCurrent: lease.isCurrent,
            }),
          });
          const request = {
            kind: 'create' as const,
            sessionId: `host-pi-request-auth-${version}`,
            cwd: directory,
            launchEnvironment: {
              values: launchEnvironment,
              unset: [],
            },
          };

          if (!supported) {
            await expect(sessions.open(request, context)).rejects.toMatchObject({
              name: 'PiRequestAuthCompatibilityError',
              code: 'pi_request_auth_version_unsupported',
              compatibility: {
                supported: false,
                reason,
                version,
                minimumVersion: '0.81.0',
              },
            });
            expect(existsSync(runtimeCapturePath)).toBe(false);
          } else {
            const session = await sessions.open(request, context);
            try {
              const runtimeCapture = JSON.parse(
                await readFileEventually(runtimeCapturePath, { timeoutMs: 5_000 }),
              ) as { args: string[]; producerVersion: string | null };
              expect(runtimeCapture.args).toEqual(expect.arrayContaining(['--mode', 'rpc', '--extension']));
              expect(runtimeCapture.producerVersion).toBe(version);
            } finally {
              await session.dispose();
            }
          }

          const probeCapture = JSON.parse(
            await readFileEventually(probeCapturePath, { timeoutMs: 5_000 }),
          ) as { args: string[]; version: string };
          expect(probeCapture).toEqual({
            args: ['--version'],
            version,
          });
        } finally {
          publications?.dispose();
          try {
            try {
              await hostOwners?.dispose();
            } finally {
              await hostSession?.close();
            }
          } finally {
            try {
              await fixture?.dispose();
            } finally {
              envScope.restore();
            }
          }
        }
      });
    },
  );
});
