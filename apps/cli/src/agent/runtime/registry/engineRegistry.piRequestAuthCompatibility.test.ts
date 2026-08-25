import { chmodSync, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it } from 'vitest';

import { readFileEventually, writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { loadBundledPluginLocators } from '../../../plugins/projection/registry/builtIn/locators';
import { createResolvedContributionRegistry } from '../../../plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '../../../plugins/projection/registry/resolvePluginContributions';
import {
  BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS,
} from '../../../plugins/projection/registry/sources/generatedBundledPluginManifests';
import { createPluginInvocationPresentation } from '../../../plugins/runtime/invocation/services/interactions';
import { resolveExecutablePluginRuntimeRegistry } from '../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry';

const PI_AGENT_ID = 'pi';
const PI_PLUGIN_ID = 'happier.agent.pi';

const PI_REQUEST_AUTH_CAPABILITY_PATH_ENV =
  'HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH';
const PI_REQUEST_AUTH_PRODUCER_VERSION_ENV =
  'HAPPIER_PI_REQUEST_AUTH_PRODUCER_VERSION';

function createPiOnlyContributionRegistry() {
  const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(
    (candidate) => candidate.pluginId === PI_PLUGIN_ID,
  );
  if (!locator) {
    throw new Error('Expected the generated Pi bundled-plugin locator');
  }
  const accountDescriptorLocators = [
    {
      pluginId: 'happier.agent.claude',
      manifest: {
        schemaVersion: 2,
        id: 'happier.agent.claude',
        version: '0.0.0',
        displayName: 'Claude account fixture',
        engines: { happier: '^0.0.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './dist/index.js' },
        contributes: {
          connectedAccountDescriptors: [{
            id: 'claude-subscription',
            title: 'Claude',
            authentication: {
              defaultModeId: 'setup-token',
              modes: [{
                id: 'setup-token',
                kind: 'manual',
                outcomeReconciliation: 'none',
                fields: [{
                  id: 'token',
                  title: 'Setup token',
                  schema: { type: 'string', minLength: 1 },
                  secret: true,
                }],
              }],
            },
          }],
        },
      },
      manifestPath: 'fixture:happier.agent.claude',
      daemonEntryPath: '@happier-dev/plugins-claude',
      sourceSpec: {
        kind: 'bundled' as const,
        locator: '@happier-dev/plugins-claude',
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
        resolvedVersion: '0.0.0',
      },
    },
    {
      pluginId: 'happier.agent.codex',
      manifest: {
        schemaVersion: 2,
        id: 'happier.agent.codex',
        version: '0.0.0',
        displayName: 'Codex account fixture',
        engines: { happier: '^0.0.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './dist/index.js' },
        contributes: {
          connectedAccountDescriptors: [{
            id: 'openai-codex',
            title: 'Codex',
            authentication: {
              defaultModeId: 'oauth',
              modes: [{
                id: 'oauth',
                kind: 'oauthAuthorizationCode',
                scopes: ['openid'],
                pkce: 'required',
                outcomeReconciliation: 'none',
              }],
            },
          }],
        },
      },
      manifestPath: 'fixture:happier.agent.codex',
      daemonEntryPath: '@happier-dev/plugins-codex',
      sourceSpec: {
        kind: 'bundled' as const,
        locator: '@happier-dev/plugins-codex',
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
        resolvedVersion: '0.0.0',
      },
    },
  ];
  const projected = projectLoadedPluginContributes({
    loadResult: {
      loadedPlugins: loadBundledPluginLocators([locator, ...accountDescriptorLocators]),
      diagnosticsByPluginId: {},
    },
    provenance: 'first_party',
  });
  return createResolvedContributionRegistry({
    ...projected,
      });
}

const VERSION_CASES = [
  { version: '0.74.2', supported: false, reason: 'version_too_old' },
  { version: '0.80.10', supported: false, reason: 'version_too_old' },
  { version: '0.81.0', supported: true, reason: null },
] as const;

describe('engineRegistry (Pi request-auth compatibility)', () => {
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
        let runtimeRegistry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        try {
          runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
            contributes: createPiOnlyContributionRegistry(),
            happyHomeDir: join(directory, 'home'),
            pluginIds: [PI_PLUGIN_ID],
          });
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
            generation: lease.generation,
            correlationId: `pi-request-auth-${version}`,
            cwd: directory,
            environment: launchEnvironment,
            signal,
            isGenerationCurrent: lease.isCurrent,
          });
          const runtime = await lease.createRuntime({ signal });
          const sessions = runtime.sessions;
          if (!sessions) {
            throw new Error('Expected Pi to expose its declared session runtime');
          }
          // Pi reads only invocation services in this process-boundary fixture.
          const context = {
            plugin: { id: PI_PLUGIN_ID, version: lease.pluginVersion },
            contribution: {
              id: PI_AGENT_ID,
              qualifiedId: `${PI_PLUGIN_ID}/agents/${PI_AGENT_ID}`,
            },
            surface: 'agent',
            signal,
            services,
            ui: createPluginInvocationPresentation({
              currentSession: null,
              signal,
              isGenerationCurrent: () => true,
            }),
            agent: { id: PI_AGENT_ID },
            protocols: {
              acp: {
                open: async () => {
                  throw new Error('Pi must not invoke the ACP composer');
                },
              },
            },
            session: { id: `host-pi-request-auth-${version}` },
            workState: {},
          } as unknown as AgentSessionRuntimeContext;
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
          await runtimeRegistry?.dispose();
          envScope.restore();
        }
      });
    },
  );
});
