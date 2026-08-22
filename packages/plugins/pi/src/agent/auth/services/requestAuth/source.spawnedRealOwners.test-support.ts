import { createRequire } from 'node:module';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';

import {
  buildConnectedServiceCredentialRecord,
  ConnectedAccountAuthFailureRequestV1Schema,
  SPAWN_SESSION_ERROR_CODES,
  type QualifiedConnectedAccountServiceRef,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';
import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import {
  createEphemeralTlsServerFixture,
} from '@happier-dev/tests/testkit/tls/ephemeralTlsServerFixture';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClient } from '../../../../../../../../apps/cli/src/api/api.js';
import {
  acquireQualifiedConnectedAccountRefreshLeaseV4,
  mutateQualifiedConnectedAccountCredentialHealthV4,
  mutateQualifiedConnectedAccountCredentialV4,
  readQualifiedConnectedAccountCredentialV4,
} from '../../../../../../../../apps/cli/src/api/client/qualifiedConnectedAccountApi.js';
import { reloadConfiguration } from '../../../../../../../../apps/cli/src/configuration.js';
import { createDaemonControlApp } from '../../../../../../../../apps/cli/src/daemon/controlServer.js';
import {
  createConnectedServiceContinuationMessageDispatcher,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/continuation/createConnectedServiceContinuationMessageDispatcher.js';
import {
  applyConnectedAccountRequestAuthRecovery,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthRecovery.js';
import {
  createConnectedAccountRequestAuthService,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService.js';
import {
  createConnectedAccountRequestAuthSubjectRegistry,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry.js';
import {
  materializeFirstPartyConnectedAccountBearer,
  resolveFirstPartyConnectedAccountBinding,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/requestAuth/firstPartyConnectedAccountRequestAuthAdapter.js';
import {
  createConnectedAccountPurposeBindingOwner,
  scopeConnectedAccountSessionPurposeBindingLease,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner.js';
import {
  ConnectedServiceRefreshCoordinator,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/refresh/ConnectedServiceRefreshCoordinator.js';
import {
  createQualifiedConnectedAccountDaemonPersistence,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/qualifiedConnectedAccountDaemonPersistence.js';
import {
  createQualifiedConnectedAccountEstablishedRuntimeOwner,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner.js';
import {
  createRuntimeAuthRecoverySchedulerForDaemon,
} from '../../../../../../../../apps/cli/src/daemon/connectedServices/runtimeAuth/createRuntimeAuthRecoverySchedulerForDaemon.js';
import { createAgentRuntimeCatalogEntryHooks } from '../../../../../../../../apps/cli/src/plugins/projection/registry/agentCatalogEntryHooks.js';
import {
  resolveExecutablePluginRuntimeRegistry,
} from '../../../../../../../../apps/cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry.js';
import { createStablePluginExecService } from '../../../../../../../../apps/cli/src/plugins/runtime/invocation/services/exec.js';
import {
  createAgentCliHostResolutionEnvironment,
  createAgentCliSystemToolService,
} from '../../../../../../../../apps/cli/src/plugins/runtime/exec/system/tools/agentCliBinding.js';
import { createPluginExecSystemToolResolver } from '../../../../../../../../apps/cli/src/plugins/runtime/exec/system/tools/resolveGrant.js';
import { PI_AGENT_RUNTIME_CONTRIBUTION } from '../../../contributions/runtime.js';
import { PLUGIN_MANIFEST } from '../../../../manifest.js';
import {
  buildPiRequestAuthExtensionAssetSource,
  PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  PI_REQUEST_AUTH_DECLARED_PURPOSES,
  resolvePiRequestAuthExtensionPath,
} from './index.js';
import { createPiRuntimeOperations } from '../../../runtime/rpc/operations.js';

const require = createRequire(import.meta.url);
const PI_AGENT_RUNTIME_SPEC = getAgentCliRuntimeSpec('pi');
const PACKAGE_DIRECTORY = fileURLToPath(new URL('../../../../../', import.meta.url));
const SPAWNED_REAL_OWNERS_TEST_ROOT = join(
  PACKAGE_DIRECTORY,
  'node_modules',
  '.cache',
  'happier-tests',
  'pi-request-auth-spawned',
);
const temporaryRoots = new Set<string>();

async function createSpawnedRealOwnersTestRoot(): Promise<string> {
  await mkdir(SPAWNED_REAL_OWNERS_TEST_ROOT, { recursive: true });
  const root = await mkdtemp(join(SPAWNED_REAL_OWNERS_TEST_ROOT, 'spawned-real-owners-'));
  temporaryRoots.add(root);
  return root;
}

async function removeTemporaryRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  temporaryRoots.delete(root);
}

afterEach(async () => {
  await Promise.all([...temporaryRoots].map(removeTemporaryRoot));
});

describe('spawned real-owner test workspace', () => {
  it('keeps temporary process fixtures outside source and removes them', async () => {
    const root = await createSpawnedRealOwnersTestRoot();
    expect(root.startsWith(`${join(PACKAGE_DIRECTORY, 'node_modules')}${sep}`)).toBe(true);
    await removeTemporaryRoot(root);
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function resolveExactPiCli(alias: string): string {
  for (const searchRoot of require.resolve.paths(alias) ?? []) {
    const candidate = join(searchRoot, alias, 'dist', 'cli.js');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Unable to resolve exact Pi CLI alias: ${alias}`);
}

async function startJoinedProductionTopologyServer(): Promise<Readonly<{
  address: string;
  accountId: string;
  dbPath: string;
  stop(): Promise<void>;
}>> {
  const packageCwd = process.cwd();
  const serverCwd = resolve(packageCwd, '../../../apps/server');
  const helperPath = join(
    serverCwd,
    'scripts/piJoinedProductionTopologyServer.test-support.ts',
  );
  const tsxCli = require.resolve('tsx/cli');
  const child = spawn(process.execPath, [
    tsxCli,
    '--tsconfig',
    join(serverCwd, 'tsconfig.json'),
    helperPath,
  ], {
    cwd: serverCwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  const lines = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });
  const ready = await Promise.race([
    (async () => {
      for await (const line of lines) {
        const parsed = JSON.parse(line) as Readonly<{
          type: string;
          address?: string;
          accountId?: string;
          dbPath?: string;
        }>;
        if (
          parsed.type === 'ready'
          && parsed.address
          && parsed.accountId
          && parsed.dbPath
        ) {
          return parsed;
        }
      }
      throw new Error(
        `Joined production-topology server exited before readiness: ${
          Buffer.concat(stderrChunks).toString('utf8')
        }`,
      );
    })(),
    new Promise<never>((_, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Joined production-topology server readiness timed out'));
      }, 120_000);
      timeout.unref();
    }),
  ]);
  let stopped = false;
  return Object.freeze({
    address: ready.address!,
    accountId: ready.accountId!,
    dbPath: ready.dbPath!,
    async stop() {
      if (stopped) return;
      stopped = true;
      const exited = once(child, 'exit');
      child.stdin.end('shutdown\n');
      await Promise.race([
        exited,
        new Promise<void>((resolveTimeout) => {
          const timeout = setTimeout(() => {
            child.kill('SIGTERM');
            resolveTimeout();
          }, 15_000);
          timeout.unref();
        }),
      ]);
      lines.close();
    },
  });
}

function codexSuccessSse(text: string): string {
  const item = {
    id: 'message-spawned-success',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const events = [
    {
      type: 'response.created',
      response: { id: 'response-spawned-success', status: 'in_progress' },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item,
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item,
    },
    {
      type: 'response.completed',
      response: {
        id: 'response-spawned-success',
        status: 'completed',
        output: [item],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function codexAccessToken(accountId: string, credentialRevision: string): string {
  const encoded = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      credential_revision: credentialRevision,
    },
  }), 'utf8').toString('base64url');
  return `header.${encoded}.signature`;
}

describe('Pi request-auth strict spawned real-owner composition', () => {
  it('projects only the explicit first-party Agent CLI system-tool binding', () => {
    const systemTools = PLUGIN_MANIFEST.contributes.systemTools ?? [];
    const hooks = createAgentRuntimeCatalogEntryHooks({
      agentId: 'pi',
      packageName: '@happier-dev/plugins-pi',
      contribution: PI_AGENT_RUNTIME_CONTRIBUTION,
      systemTools,
    })();

    expect(hooks.agentCliSystemTool).toEqual({ toolId: 'pi-cli' });

    const matchingNamesWithoutBinding = createAgentRuntimeCatalogEntryHooks({
      agentId: 'pi',
      packageName: '@happier-dev/plugins-pi',
      contribution: {
        ...PI_AGENT_RUNTIME_CONTRIBUTION,
        agentCliSystemTool: undefined,
      },
      systemTools,
    })();
    expect(matchingNamesWithoutBinding).not.toHaveProperty('agentCliSystemTool');

    expect(() => createAgentRuntimeCatalogEntryHooks({
      agentId: 'pi',
      packageName: '@happier-dev/plugins-pi',
      contribution: {
        ...PI_AGENT_RUNTIME_CONTRIBUTION,
        agentCliSystemTool: { toolId: 'missing-tool' },
      },
      systemTools,
    })).toThrow(/declared system tool/i);

    expect(() => createAgentRuntimeCatalogEntryHooks({
      agentId: 'pi',
      packageName: '@happier-dev/plugins-pi',
      contribution: {
        ...PI_AGENT_RUNTIME_CONTRIBUTION,
        agentCliSystemTool: { toolId: '  ' },
      },
      systemTools,
    })).toThrow(/toolId/i);
  });

  it('fails closed on an invalid explicit override instead of falling back to PATH', async () => {
    const root = await createSpawnedRealOwnersTestRoot();
    const pathPi = join(root, 'pi');
    await writeFile(pathPi, '#!/bin/sh\nprintf "0.82.1\\n"\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    const delegate = createPluginExecSystemToolResolver({
      definitions: [{
        toolId: 'pi-cli',
        displayName: 'Pi coding-agent CLI',
        lookupNames: ['pi'],
      }],
      baseEnv: { PATH: root },
      registerGrant() {},
    });
    const systemTools = createAgentCliSystemToolService({
      agentId: 'pi',
      runtimeSpec: PI_AGENT_RUNTIME_SPEC,
      binding: { toolId: 'pi-cli' },
      definition: {
        toolId: 'pi-cli',
        displayName: 'Pi coding-agent CLI',
        lookupNames: ['pi'],
      },
      processEnv: {
        ...process.env,
        HAPPIER_HOME_DIR: join(root, 'missing-home'),
        HAPPIER_PI_PATH: join(root, 'missing-pi'),
        PATH: root,
      },
      delegate,
    });

    await expect(systemTools.resolve({
      toolId: 'pi-cli',
      purpose: 'Prove invalid override refusal',
      cwd: root,
    })).rejects.toMatchObject({
      code: 'plugin_exec_system_tool_unavailable',
    });

    const missingSystemTools = createAgentCliSystemToolService({
      agentId: 'pi',
      runtimeSpec: PI_AGENT_RUNTIME_SPEC,
      binding: { toolId: 'pi-cli' },
      definition: {
        toolId: 'pi-cli',
        displayName: 'Pi coding-agent CLI',
        lookupNames: ['pi'],
      },
      processEnv: {
        ...process.env,
        HAPPIER_HOME_DIR: join(root, 'missing-home'),
        HAPPIER_PI_PATH: undefined,
        PATH: '',
      },
      delegate,
    });
    await expect(missingSystemTools.resolve({
      toolId: 'pi-cli',
      purpose: 'Prove missing executable refusal',
      cwd: root,
    })).rejects.toMatchObject({
      code: 'plugin_exec_system_tool_unavailable',
    });
  });

  it('keeps canonical PATH fallback and delegates every unbound tool unchanged', async () => {
    const root = await createSpawnedRealOwnersTestRoot();
    const pathPi = join(root, 'pi');
    const otherTool = join(root, 'other-tool');
    await writeFile(pathPi, '#!/bin/sh\nprintf "0.82.1\\n"\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    await writeFile(otherTool, '#!/bin/sh\nexit 0\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    const delegate = createPluginExecSystemToolResolver({
      definitions: [{
        toolId: 'pi-cli',
        displayName: 'Pi coding-agent CLI',
        lookupNames: ['pi'],
      }, {
        toolId: 'other-tool',
        displayName: 'Other tool',
        lookupNames: ['other-tool'],
      }],
      baseEnv: { PATH: root },
      registerGrant() {},
    });
    const systemTools = createAgentCliSystemToolService({
      agentId: 'pi',
      runtimeSpec: PI_AGENT_RUNTIME_SPEC,
      binding: { toolId: 'pi-cli' },
      definition: {
        toolId: 'pi-cli',
        displayName: 'Pi coding-agent CLI',
        lookupNames: ['pi'],
      },
      processEnv: {
        ...process.env,
        HAPPIER_PI_PATH: undefined,
        PATH: root,
      },
      delegate,
    });

    await expect(systemTools.resolve({
      toolId: 'pi-cli',
      purpose: 'Prove canonical PATH fallback',
      cwd: root,
    })).resolves.toMatchObject({
      executablePath: pathPi,
    });
    await expect(systemTools.resolve({
      toolId: 'other-tool',
      purpose: 'Prove unrelated delegation',
      cwd: root,
    })).resolves.toMatchObject({
      executablePath: otherTool,
    });
  });

  it('preserves the JavaScript runtime selected by the canonical host environment', async () => {
    const root = await createSpawnedRealOwnersTestRoot();
    const piEntryPoint = join(root, 'pi.js');
    const javascriptRuntime = join(root, 'explicit-js-runtime');
    await writeFile(piEntryPoint, '#!/usr/bin/env node\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    await writeFile(javascriptRuntime, '#!/bin/sh\nexit 0\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    const definition = {
      toolId: 'pi-cli',
      displayName: 'Pi coding-agent CLI',
      lookupNames: ['pi'],
    } as const;
    const processEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HAPPIER_PI_PATH: piEntryPoint,
      HAPPIER_JS_RUNTIME_PATH: javascriptRuntime,
      PATH: '',
    };
    const systemTools = createAgentCliSystemToolService({
      agentId: 'pi',
      runtimeSpec: PI_AGENT_RUNTIME_SPEC,
      binding: { toolId: 'pi-cli' },
      definition,
      processEnv,
      delegate: createPluginExecSystemToolResolver({
        definitions: [definition],
        baseEnv: processEnv,
        registerGrant() {},
      }),
    });

    await expect(systemTools.resolve({
      toolId: 'pi-cli',
      purpose: 'Prove canonical JavaScript runtime identity',
      cwd: root,
    })).resolves.toMatchObject({
      executablePath: piEntryPoint,
      launch: {
        executablePath: javascriptRuntime,
        args: [piEntryPoint],
      },
    });
  });

  it('uses the same canonical override for Pi preflight and runtime resolution', async () => {
    const root = await createSpawnedRealOwnersTestRoot();
    const exactPi = join(root, 'exact-pi');
    const conflictingBin = join(root, 'conflicting-bin');
    await mkdir(conflictingBin, { recursive: true });
    await writeFile(
      exactPi,
      [
        '#!/bin/sh',
        'if [ "$1" = "--list-models" ]; then',
        '  printf "provider model context max-out thinking images\\n"',
        '  printf "anthropic exact-model 200K 64K yes yes\\n"',
        '  exit 0',
        'fi',
        'printf "0.82.1\\n"',
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o755 },
    );
    await writeFile(join(conflictingBin, 'pi'), '#!/bin/sh\nexit 91\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    const processEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HAPPIER_PI_PATH: exactPi,
      PATH: conflictingBin,
    };
    const systemTools = PLUGIN_MANIFEST.contributes.systemTools ?? [];
    const hooks = createAgentRuntimeCatalogEntryHooks({
      agentId: 'pi',
      packageName: '@happier-dev/plugins-pi',
      contribution: PI_AGENT_RUNTIME_CONTRIBUTION,
      systemTools,
    })();
    const preflight = await hooks.getPreflightSessionControlsProbeAdapter?.();

    await expect(preflight?.probeModelsRaw?.({
      cwd: root,
      timeoutMs: 5_000,
      backendTarget: undefined,
      accountSettings: null,
      env: processEnv,
    })).resolves.toEqual([
      expect.objectContaining({ id: 'anthropic/exact-model' }),
    ]);

    const definitions = [{
      toolId: 'pi-cli',
      displayName: 'Pi coding-agent CLI',
      lookupNames: ['pi'],
    }] as const;
    const runtimeSystemTools = createAgentCliSystemToolService({
      agentId: 'pi',
      runtimeSpec: PI_AGENT_RUNTIME_SPEC,
      binding: { toolId: 'pi-cli' },
      definition: definitions[0],
      processEnv,
      delegate: createPluginExecSystemToolResolver({
        definitions,
        baseEnv: processEnv,
        registerGrant() {},
      }),
    });
    await expect(runtimeSystemTools.resolve({
      toolId: 'pi-cli',
      purpose: 'Prove runtime source identity',
      cwd: root,
    })).resolves.toMatchObject({
      executablePath: exactPi,
    });
  });

  it(
    'launches the exact host-resolved Pi 0.82.1 RPC binary without leaking selector env',
    async () => {
      const root = await createSpawnedRealOwnersTestRoot();
      const agentDir = join(root, 'agent');
      const capabilityPath = join(root, 'request-auth-capability.json');
      const exactPiCli = resolveExactPiCli('pi-coding-agent-0821');
      await mkdir(join(agentDir, 'extensions'), { recursive: true });
      await writeFile(resolvePiRequestAuthExtensionPath(agentDir), 'export default function () {};\n', 'utf8');
      await writeFile(capabilityPath, '{}\n', 'utf8');

      const abortController = new AbortController();
      const executable: ManagedExecutableRef = Object.freeze({
        kind: 'systemTool',
        id: 'pi-cli',
      });
      const resolvedRequests: Array<Readonly<{ request: unknown; executablePath: string }>> = [];
      const conflictingPathRoot = join(root, 'conflicting-path');
      await mkdir(conflictingPathRoot, { recursive: true });
      await writeFile(join(conflictingPathRoot, 'pi'), '#!/bin/sh\nexit 91\n', {
        encoding: 'utf8',
        mode: 0o755,
      });
      const realSystemTools = createPluginExecSystemToolResolver({
        definitions: [{
          toolId: 'pi-cli',
          displayName: 'Pi coding-agent CLI',
          lookupNames: ['pi'],
        }],
        baseEnv: { PATH: '' },
        registerGrant() {},
      });
      const hostResolutionEnv = createAgentCliHostResolutionEnvironment({
        processEnv: {
          ...process.env,
          HAPPIER_PI_PATH: exactPiCli,
          HOME: join(root, 'host-home'),
          PATH: conflictingPathRoot,
        },
        happyHomeDir: join(root, 'happy-home'),
      });
      expect(hostResolutionEnv).toMatchObject({
        HAPPIER_HOME_DIR: join(root, 'happy-home'),
        HOME: join(root, 'host-home'),
      });
      const boundSystemTools = createAgentCliSystemToolService({
        agentId: 'pi',
        runtimeSpec: PI_AGENT_RUNTIME_SPEC,
        binding: { toolId: 'pi-cli' },
        definition: {
          toolId: 'pi-cli',
          displayName: 'Pi coding-agent CLI',
          lookupNames: ['pi'],
        },
        processEnv: hostResolutionEnv,
        delegate: realSystemTools,
      });
      const exec = createStablePluginExecService({
        allowedExecutables: [executable],
        allowedEnvKeys: [
          'CI',
          'DEBUG',
          'HOME',
          'NODE_ENV',
          'PATH',
          'PI_CODING_AGENT_DIR',
          PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
          'HAPPIER_PI_REQUEST_AUTH_PRODUCER_VERSION',
          'XDG_CONFIG_HOME',
        ],
        environment: {
          PATH: '',
        },
        allowedCwdScopes: [{
          root: 'workspace',
          pathPrefix: '',
          access: ['read'],
        }],
        signal: abortController.signal,
        isGenerationCurrent: () => true,
        async resolveExecutable() {
          throw new Error('Only the declared Pi system tool is allowed');
        },
        async resolvePath(path) {
          if (path.root !== 'workspace') {
            throw new Error(`Unexpected path root: ${path.root}`);
          }
          return join(root, path.relativePath);
        },
        systemTools: {
          async resolve(request) {
            const resolved = await boundSystemTools.resolve(request);
            resolvedRequests.push({ request, executablePath: resolved.executablePath });
            return resolved;
          },
        },
      });
      let versionProbeExecutable: ManagedExecutableRef | null = null;
      let runtimeSpawnExecutable: ManagedExecutableRef | null = null;
      let runtimeSpawnEnvironment: Readonly<Record<string, string>> | undefined;
      const recordingClients: typeof exec.clients = Object.freeze({
        ...exec.clients,
        async spawn(spec, options) {
          runtimeSpawnExecutable = spec.launch.executable;
          runtimeSpawnEnvironment = spec.launch.env;
          return await exec.clients.spawn(spec, options);
        },
      });
      const execWithPostProbePathMutation = Object.freeze({
        ...exec,
        clients: recordingClients,
        async run(request: Parameters<typeof exec.run>[0]) {
          versionProbeExecutable = request.executable;
          const result = await exec.run(request);
          hostResolutionEnv.HAPPIER_PI_PATH = join(root, 'missing-after-probe');
          hostResolutionEnv.PATH = '';
          return result;
        },
      });

      let runtime: Awaited<ReturnType<typeof createPiRuntimeOperations>> | null = null;
      try {
        runtime = await createPiRuntimeOperations({
          services: { exec: execWithPostProbePathMutation },
          logger: {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
          },
          cwd: root,
          env: {
            PI_CODING_AGENT_DIR: agentDir,
            [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: capabilityPath,
            HOME: join(root, 'isolated-pi-home'),
            XDG_CONFIG_HOME: join(root, 'isolated-pi-home', '.config'),
          },
          sessionId: 'strict-spawned-host-session',
          initialSessionId: null,
        });

        expect(resolvedRequests).toEqual([
          expect.objectContaining({
            request: expect.objectContaining({
              toolId: 'pi-cli',
            }),
            executablePath: exactPiCli,
          }),
        ]);
        expect(versionProbeExecutable).not.toBeNull();
        expect(runtimeSpawnExecutable).toBe(versionProbeExecutable);
        expect(runtimeSpawnEnvironment).toMatchObject({
          HOME: join(root, 'isolated-pi-home'),
          XDG_CONFIG_HOME: join(root, 'isolated-pi-home', '.config'),
        });
        expect(runtimeSpawnEnvironment).not.toHaveProperty('HAPPIER_PI_PATH');
        expect(runtimeSpawnEnvironment).not.toHaveProperty('HAPPIER_HOME_DIR');
      } finally {
        await runtime?.dispose();
        abortController.abort();
      }
    },
    30_000,
  );

  it(
    'joins exact Pi 0.82.1 through qualified request-auth, recovery, and SQLite owners',
    async () => {
      const root = await createSpawnedRealOwnersTestRoot();
      const agentDir = join(root, 'agent');
      const exactPiCli = resolveExactPiCli('pi-coding-agent-0821');
      await mkdir(join(agentDir, 'extensions'), { recursive: true });

      const serverSelectionEnvKeys = [
        'HAPPIER_ACTIVE_SERVER_ID',
        'HAPPIER_SERVER_URL',
        'HAPPIER_LOCAL_SERVER_URL',
        'HAPPIER_PUBLIC_SERVER_URL',
        'HAPPIER_WEBAPP_URL',
      ] as const;
      const previousServerSelectionEnv = new Map(
        serverSelectionEnvKeys.map((key) => [key, process.env[key]]),
      );
      const joinedServer = await startJoinedProductionTopologyServer();
      delete process.env.HAPPIER_ACTIVE_SERVER_ID;
      process.env.HAPPIER_SERVER_URL = joinedServer.address;
      delete process.env.HAPPIER_LOCAL_SERVER_URL;
      delete process.env.HAPPIER_PUBLIC_SERVER_URL;
      process.env.HAPPIER_WEBAPP_URL = joinedServer.address;
      reloadConfiguration();
      const credentials = {
        token: joinedServer.accountId,
        encryption: {
          type: 'legacy' as const,
          secret: new Uint8Array(32).fill(7),
        },
      };
      const api = await ApiClient.create(credentials);
      const initialAccessToken = codexAccessToken(
        'primary',
        'joined-token-a',
      );
      const rotatedAccessToken = codexAccessToken(
        'primary',
        'joined-token-b',
      );
      const initialStoredCredential = buildConnectedServiceCredentialRecord({
        now: Date.now(),
        serviceId: 'openai-codex',
        profileId: 'primary',
        kind: 'oauth',
        expiresAt: Date.now() + 60 * 60_000,
        oauth: {
          accessToken: initialAccessToken,
          refreshToken: 'refresh-token-a',
          idToken: null,
          providerAccountId: 'primary',
          providerEmail: null,
          scope: 'openid',
          tokenType: 'Bearer',
        },
      });
      const initialServerMutation =
        await api.registerConnectedServiceCredentialPlain({
          serviceId: 'openai-codex',
          profileId: 'primary',
          content: { t: 'plain', v: initialStoredCredential },
          expectedCredentialRevision: null,
        });
      if (!('credentialRevision' in initialServerMutation)) {
        throw new Error('joined_topology_initial_credential_write_unfenced');
      }
      const qualifiedAccount = {
        service: {
          pluginId: 'happier.agent.codex',
          localId: 'openai-codex',
        },
        accountId: 'primary',
      } as const;
      const initialQualifiedSnapshot =
        await readQualifiedConnectedAccountCredentialV4({
          token: credentials.token,
          ref: qualifiedAccount,
        });
      expect(initialQualifiedSnapshot).toMatchObject({
        ref: qualifiedAccount,
        authenticationModeId: 'oauth',
        credentialRevision: initialServerMutation.credentialRevision,
      });
      const pluginRuntimeRegistry =
        await resolveExecutablePluginRuntimeRegistry({
          happyHomeDir: join(root, 'qualified-runtime-home'),
          pluginIds: [qualifiedAccount.service.pluginId],
        });
      const connectedAccountPersistence =
        createQualifiedConnectedAccountDaemonPersistence({
          credentials,
          getAccountEncryptionMode: () => api.getAccountEncryptionMode(),
          secrets: {
            has: async () => false,
            read: async () => null,
          },
          readAccountSettings: () => ({}),
          updateAccountSettings: async (mutate) => mutate({}),
        });
      const establishedConnectedAccountRuntimeOwner =
        createQualifiedConnectedAccountEstablishedRuntimeOwner({
          reloadController: {
            async acquireRuntimeRegistry() {
              return {
                registry: pluginRuntimeRegistry,
                source: 'active' as const,
                release: async () => undefined,
              };
            },
            isRuntimeRegistryCurrent(candidate) {
              return candidate === pluginRuntimeRegistry;
            },
          },
          credentials,
          getAccountEncryptionMode: () => api.getAccountEncryptionMode(),
          configuration: connectedAccountPersistence.configuration,
        });
      const initialQualifiedStatus =
        await establishedConnectedAccountRuntimeOwner.invokeWithReceipt({
          account: qualifiedAccount,
          operation: { kind: 'status' },
        });
      expect(initialQualifiedStatus).toMatchObject({
        result: { status: 'connected' },
        basis: {
          credentialRevision: initialServerMutation.credentialRevision,
        },
      });
      const oauthRefreshRequests: Array<Readonly<{
        method: string | undefined;
        url: string | undefined;
        body: string;
      }>> = [];
      const oauthRefreshServer = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        oauthRefreshRequests.push({
          method: request.method,
          url: request.url,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          access_token: rotatedAccessToken,
          refresh_token: 'refresh-token-b',
          id_token: 'id-token-b',
          expires_in: 3_600,
          account_id: 'primary',
        }));
      });
      oauthRefreshServer.listen(0, '127.0.0.1');
      await once(oauthRefreshServer, 'listening');
      const oauthRefreshAddress = oauthRefreshServer.address();
      if (!oauthRefreshAddress || typeof oauthRefreshAddress !== 'object') {
        throw new Error('missing_joined_oauth_refresh_address');
      }
      const previousOauthRefreshUrl =
        process.env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL;
      const oauthRefreshUrl =
        `http://127.0.0.1:${oauthRefreshAddress.port}/oauth/token`;
      process.env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL =
        oauthRefreshUrl;
      const systemFetch = globalThis.fetch;
      vi.stubGlobal('fetch', async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        if (url !== 'https://auth.openai.com/oauth/token') {
          throw new Error(`joined_topology_unexpected_external_fetch:${url}`);
        }
        return await systemFetch(oauthRefreshUrl, init);
      });

      const tlsFixture = await createEphemeralTlsServerFixture({
        additionalDnsNames: ['chatgpt.com'],
      });
      temporaryRoots.add(tlsFixture.directoryPath);
      const providerAttempts: Array<Readonly<{
        authorization: string | undefined;
        accountId: string | undefined;
      }>> = [];
      const providerSockets = new Set<import('node:stream').Duplex>();
      const providerConnectTargets: string[] = [];
      const decryptedProvider = createServer((request, response) => {
        providerAttempts.push({
          authorization: request.headers.authorization,
          accountId: Array.isArray(request.headers['chatgpt-account-id'])
            ? request.headers['chatgpt-account-id'][0]
            : request.headers['chatgpt-account-id'],
        });
        request.resume();
        if (providerAttempts.length === 1) {
          response.statusCode = 401;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_api_key',
              message: 'invalid bearer token',
            },
          }));
          return;
        }
        response.statusCode = 200;
        response.setHeader('content-type', 'text/event-stream');
        response.end(codexSuccessSse(
          'spawned current-owner recovery succeeded',
        ));
      });
      const provider = createServer((_request, response) => {
        response.statusCode = 400;
        response.end('CONNECT required');
      });
      provider.on('connect', (request, socket, head) => {
        const target = request.url ?? '';
        providerConnectTargets.push(target);
        providerSockets.add(socket);
        socket.once('close', () => providerSockets.delete(socket));
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) socket.unshift(head);
        const tlsSocket = new TLSSocket(socket, {
          isServer: true,
          secureContext: tlsFixture.secureContext,
          ALPNProtocols: ['http/1.1'],
        });
        providerSockets.add(tlsSocket);
        tlsSocket.once('close', () => providerSockets.delete(tlsSocket));
        tlsSocket.once('secure', () => {
          decryptedProvider.emit('connection', tlsSocket);
        });
        tlsSocket.once('error', () => {
          tlsSocket.destroy();
        });
      });
      provider.listen(0, '127.0.0.1');
      await once(provider, 'listening');
      const providerAddress = provider.address();
      if (!providerAddress || typeof providerAddress !== 'object') {
        throw new Error('missing_spawned_provider_address');
      }
      const providerProxyUrl = `http://127.0.0.1:${providerAddress.port}`;

      const service = {
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      } satisfies QualifiedConnectedAccountServiceRef;
      const purpose = PI_REQUEST_AUTH_DECLARED_PURPOSES['openai-codex'];
      const declaredRequestAuthUse =
        PI_AGENT_RUNTIME_CONTRIBUTION.connectedServices.requestAuthUses.find(
          (candidate) => (
            candidate.purpose === purpose.purpose
          ),
        );
      if (!declaredRequestAuthUse) {
        throw new Error('missing_declared_openai_codex_request_auth_use');
      }
      const binding = {
        purpose,
        target: {
          kind: 'account' as const,
          account: {
            service,
            accountId: 'primary',
          },
        },
      };
      let credentialRevision = initialServerMutation.credentialRevision;
      let lookups = 0;
      let reports = 0;
      let materializations = 0;
      const reportBodies: unknown[] = [];
      const refreshObservations: unknown[] = [];
      let durablePurposeBindings: QualifiedConnectedAccountPurposeBindingsV1 = {
        v: 1 as const,
        bindings: [],
      };
      const durablePurposeBindingListeners = new Set<() => void>();
      const purposeBindingOwner = createConnectedAccountPurposeBindingOwner({
        store: {
          read: async () => durablePurposeBindings,
          update: async (mutate) => {
            durablePurposeBindings = mutate(durablePurposeBindings);
            for (const listener of durablePurposeBindingListeners) listener();
            return durablePurposeBindings;
          },
          subscribe(listener) {
            durablePurposeBindingListeners.add(listener);
            return {
              dispose: () => durablePurposeBindingListeners.delete(listener),
            };
          },
        },
        selectTarget: async () => {
          throw new Error('joined_topology_unexpected_interactive_selection');
        },
        resolveTarget: async (target) => target.kind === 'account'
          ? {
              displayName: 'Primary OpenAI Codex account',
              account: target.account,
            }
          : null,
        materializeAccount: async () => {
          throw new Error('joined_topology_unexpected_generic_materialization');
        },
      });
      const sessionPurposeBindingLease =
        purposeBindingOwner.activateSessionPurposeBindings({
          sessionId: 'strict-spawned-host-session',
          purposes: [purpose],
          bindings: [binding],
        });
      const subject = scopeConnectedAccountSessionPurposeBindingLease({
        lease: sessionPurposeBindingLease,
        subjectId: `${sessionPurposeBindingLease.subjectId}/agent:pi`,
        uses: [{
          purpose,
          materialization: declaredRequestAuthUse.materialization,
        }],
        registerRedaction: () => undefined,
      });
      const qualifiedRefreshOwnerEffects: unknown[] = [];
      const refreshCoordinator = new ConnectedServiceRefreshCoordinator({
        api,
        credentials,
        machineIdProvider: () => 'machine-strict-spawned',
        ownerIdProvider: () => 'machine-strict-spawned:joined-topology',
        activeServerDir: join(root, 'refresh-active'),
        baseDir: join(root, 'refresh-materialized'),
        refreshWindowMs: 60_000,
        refreshLeaseMs: 30_000,
        now: () => Date.now(),
        qualifiedConnectedAccountRuntime: {
          resolvePeerClass: () => 'advertised_v4',
          resolveOperationTransport: () => ({ kind: 'v4' }),
          establishedRuntimeOwner:
            establishedConnectedAccountRuntimeOwner,
          readCredential: async (input) => {
            const result =
              await readQualifiedConnectedAccountCredentialV4(input);
            qualifiedRefreshOwnerEffects.push({
              operation: 'readCredential',
              credentialRevision: result?.credentialRevision ?? null,
            });
            return result;
          },
          acquireRefreshLease: async (input) => {
            const result =
              await acquireQualifiedConnectedAccountRefreshLeaseV4(input);
            qualifiedRefreshOwnerEffects.push({
              operation: 'acquireRefreshLease',
              acquired: result.acquired,
              credentialRevision: result.credentialRevision,
            });
            return result;
          },
          mutateCredential: async (input) => {
            const result =
              await mutateQualifiedConnectedAccountCredentialV4(input);
            qualifiedRefreshOwnerEffects.push({
              operation: 'mutateCredential',
              credentialRevision: result.credentialRevision,
            });
            return result;
          },
          mutateCredentialHealth: async (input) => {
            const result =
              await mutateQualifiedConnectedAccountCredentialHealthV4(input);
            qualifiedRefreshOwnerEffects.push({
              operation: 'mutateCredentialHealth',
              credentialRevision: result.credentialRevision,
            });
            return result;
          },
        },
      });
      const currentProjection = () => ({
        groups: [],
        resolveCredentialRevision: (
          serviceId: string,
          profileId: string,
        ) => (
          serviceId === 'openai-codex' && profileId === 'primary'
            ? credentialRevision
            : null
        ),
      });
      const requestAuthService = createConnectedAccountRequestAuthService({
        resolveCurrentBinding: (currentBinding) =>
          resolveFirstPartyConnectedAccountBinding(
            currentBinding,
            currentProjection(),
          ),
        materializeBearer: async ({ resolved, materialization }) => {
          materializations += 1;
          return await materializeFirstPartyConnectedAccountBearer({
            resolved,
            materialization,
            transport: { kind: 'v4' },
            establishedRuntimeOwner:
              establishedConnectedAccountRuntimeOwner,
            resolveCredential: async () => {
              throw new Error(
                'joined_topology_unexpected_legacy_credential_resolution',
              );
            },
          });
        },
        refreshAfterAuthFailure: async ({ resolved, failure }) => {
          const before = credentialRevision;
          const recovery = await applyConnectedAccountRequestAuthRecovery({
            resolved,
            failure,
            refreshCredential: async ({ account, expectedCredentialRevision }) => {
              try {
                const refreshed =
                  await refreshCoordinator.refreshConnectedServiceCredentialForQuota({
                    serviceId: 'openai-codex',
                    profileId: account.accountId,
                    force: true,
                    expectedCredentialRevision,
                  });
                const persisted =
                  await api.getConnectedServiceCredentialPlain({
                    serviceId: 'openai-codex',
                    profileId: account.accountId,
                  });
                refreshObservations.push({
                  refreshed: refreshed !== null,
                  revisionSemantics: persisted?.revisionSemantics ?? null,
                  credentialRevision:
                    persisted?.revisionSemantics === 'revisioned'
                      ? persisted.credentialRevision
                      : null,
                  oauthRefreshRequestCount: oauthRefreshRequests.filter(
                    ({ method }) => method === 'POST',
                  ).length,
                  oauthRefreshRequests,
                  qualifiedRefreshOwnerEffects,
                });
                if (
                  !refreshed
                  || !persisted
                  || persisted.revisionSemantics !== 'revisioned'
                ) {
                  return false;
                }
                credentialRevision = persisted.credentialRevision;
                return credentialRevision !== expectedCredentialRevision;
              } catch (error) {
                refreshObservations.push({
                  error: error instanceof Error ? error.message : String(error),
                  oauthRefreshRequestCount: oauthRefreshRequests.filter(
                    ({ method }) => method === 'POST',
                  ).length,
                  oauthRefreshRequests,
                  qualifiedRefreshOwnerEffects,
                });
                throw error;
              }
            },
            switchAfterClassifiedFailure: async () => ({
              status: 'no_candidate' as const,
            }),
            recordTemporaryRetry: async () => ({
              status: 'recorded' as const,
            }),
          });
          if (
            recovery.effect === 'stale_context'
            || recovery.effect === 'temporary_retry_unavailable'
          ) {
            return { status: 'denied' as const };
          }
          return {
            status: before === credentialRevision
              ? 'current_unchanged' as const
              : 'current_changed' as const,
          };
        },
        reportQuotaFailure: async () => {
          reports += 1;
          return { status: 'current_unchanged' };
        },
      });
      const registry = createConnectedAccountRequestAuthSubjectRegistry();

      const continuationSendBoundary = vi.fn(async () => ({
        ok: true as const,
        sessionId: 'strict-spawned-host-session',
        localId: 'unexpected-continuation',
        waited: false,
      }));
      const continuationDispatcher =
        createConnectedServiceContinuationMessageDispatcher({
          credentials: {
            token: 'unused',
            encryption: {
              type: 'legacy',
              secret: new Uint8Array(32).fill(9),
            },
          },
          sendMessage: continuationSendBoundary as never,
        });
      const recoveryBoundary = vi.fn(async () => {
        await continuationDispatcher.enqueueInterruptedOriginContinuation({
          sessionId: 'strict-spawned-host-session',
          attemptId: 'unexpected-scheduler-attempt',
          interruptedOriginId: 'unexpected-scheduler-origin',
          interruption: 'provider_failed_turn',
          resumePromptMode: 'standard',
        });
      });
      const recoveryScheduler =
        createRuntimeAuthRecoverySchedulerForDaemon({
          activeServerDir: join(root, 'recovery-active'),
          nowMs: () => 1_000,
          recover: recoveryBoundary as never,
        });
      const genericRuntimeAdapterInputs: unknown[] = [];
      const app = createDaemonControlApp({
        getChildren: () => [],
        machineId: 'machine-strict-spawned',
        stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
          errorMessage: 'unused',
        }),
        requestShutdown: () => undefined,
        onHappySessionWebhook: () => undefined,
        controlToken: 'master-token',
        connectedAccountRequestAuth: {
          authenticate: registry.authenticate,
          lookupRequestAuth: async (input) => {
            lookups += 1;
            return await requestAuthService.lookupRequestAuth(input);
          },
          refreshAfterAuthFailure:
            async (input) => {
              reports += 1;
              reportBodies.push(input.request);
              return await requestAuthService.refreshAfterAuthFailure(input);
            },
          reportQuotaFailure: requestAuthService.reportQuotaFailure,
        },
        runtimeAuthRecoveryScheduler:
          recoveryScheduler,
        handleConnectedServiceRuntimeAuthFailure: async (input) => {
          genericRuntimeAdapterInputs.push(input);
          return { status: 'unexpected' };
        },
      });
      const daemonAddress = await app.listen({
        host: '127.0.0.1',
        port: 0,
      });
      const capability = await registry.activate({
        subject,
        materializedRootDir: root,
        materializationId: 'strict-spawned-pi-request-auth',
        httpPort: Number(new URL(daemonAddress).port),
      });
      await writeFile(
        resolvePiRequestAuthExtensionPath(agentDir),
        buildPiRequestAuthExtensionAssetSource({
          'openai-codex': purpose,
        }),
        'utf8',
      );
      await writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({
          retry: {
            enabled: false,
            maxRetries: 0,
            provider: { maxRetries: 0 },
          },
        }),
        'utf8',
      );

      const abortController = new AbortController();
      const executable: ManagedExecutableRef = Object.freeze({
        kind: 'systemTool',
        id: 'pi-cli',
      });
      const hostResolutionEnv = createAgentCliHostResolutionEnvironment({
        processEnv: {
          ...process.env,
          HAPPIER_PI_PATH: exactPiCli,
          PATH: '',
        },
        happyHomeDir: join(root, 'happy-home'),
      });
      const definition = {
        toolId: 'pi-cli',
        displayName: 'Pi coding-agent CLI',
        lookupNames: ['pi'],
      } as const;
      const boundSystemTools = createAgentCliSystemToolService({
        agentId: 'pi',
        runtimeSpec: PI_AGENT_RUNTIME_SPEC,
        binding: { toolId: 'pi-cli' },
        definition,
        processEnv: hostResolutionEnv,
        delegate: createPluginExecSystemToolResolver({
          definitions: [definition],
          baseEnv: { PATH: '' },
          registerGrant() {},
        }),
      });
      const exec = createStablePluginExecService({
        allowedExecutables: [executable],
        allowedEnvKeys: [
          'CI',
          'DEBUG',
          'HOME',
          'HTTPS_PROXY',
          'HTTP_PROXY',
          'NODE_EXTRA_CA_CERTS',
          'NODE_ENV',
          'NO_PROXY',
          'PATH',
          'PI_CODING_AGENT_DIR',
          PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
          'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON',
          'HAPPIER_PI_REQUEST_AUTH_PRODUCER_VERSION',
          'XDG_CONFIG_HOME',
        ],
        environment: { PATH: '' },
        allowedCwdScopes: [{
          root: 'workspace',
          pathPrefix: '',
          access: ['read'],
        }],
        signal: abortController.signal,
        isGenerationCurrent: () => true,
        async resolveExecutable() {
          throw new Error('Only the declared Pi system tool is allowed');
        },
        async resolvePath(path) {
          if (path.root !== 'workspace') {
            throw new Error(`Unexpected path root: ${path.root}`);
          }
          return join(root, path.relativePath);
        },
        systemTools: boundSystemTools,
      });

      let runtime: Awaited<ReturnType<typeof createPiRuntimeOperations>> | null =
        null;
      const events: AgentSessionRuntimeEvent[] = [];
      try {
        runtime = await createPiRuntimeOperations({
          services: { exec },
          logger: {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
          },
          cwd: root,
          env: {
            PI_CODING_AGENT_DIR: agentDir,
            [PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]: capability.path,
            HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([{
              serviceId: 'openai-codex',
            }]),
            HOME: join(root, 'isolated-pi-home'),
            HTTPS_PROXY: providerProxyUrl,
            HTTP_PROXY: providerProxyUrl,
            NODE_EXTRA_CA_CERTS: tlsFixture.caCertificatePath,
            NO_PROXY: '127.0.0.1,localhost',
            XDG_CONFIG_HOME: join(root, 'isolated-pi-home', '.config'),
          },
          sessionId: 'strict-spawned-host-session',
          initialSessionId: null,
        });
        const watch = runtime.watch((event) => {
          events.push(event);
        });
        const admission = await runtime.send({
          inputIds: ['strict-spawned-input'],
          input: { text: 'prove spawned current-owner recovery' },
          delivery: {
            kind: 'newTurn',
            turnId: 'strict-spawned-turn',
          },
        });
        expect(admission).toEqual({ status: 'admitted' });
        await vi.waitFor(() => {
          expect(refreshObservations.length).toBeGreaterThan(0);
        }, { timeout: 20_000, interval: 10 });
        expect(
          refreshObservations,
          JSON.stringify(refreshObservations),
        ).toMatchObject([{
          refreshed: true,
          revisionSemantics: 'revisioned',
          oauthRefreshRequestCount: 1,
        }]);
        await vi.waitFor(() => {
          expect(events.some((event) => event.kind === 'turn-complete')).toBe(
            true,
          );
        }, { timeout: 20_000, interval: 10 });
        watch.dispose();
        expect(
          providerAttempts,
          JSON.stringify({
            refreshObservations,
            oauthRefreshRequestCount: oauthRefreshRequests.length,
            eventKinds: events.map((event) => event.kind),
          }),
        ).toHaveLength(2);

        expect(providerAttempts).toEqual([
          {
            authorization: `Bearer ${initialAccessToken}`,
            accountId: 'primary',
          },
          {
            authorization: `Bearer ${rotatedAccessToken}`,
            accountId: 'primary',
          },
        ]);
        expect(providerConnectTargets.length).toBeGreaterThan(0);
        const declaredOrigin = new URL(
          declaredRequestAuthUse.materialization.origin,
        );
        const declaredConnectTarget =
          `${declaredOrigin.hostname}:${declaredOrigin.port || '443'}`;
        expect(
          providerConnectTargets.every(
            (target) => target === declaredConnectTarget,
          ),
        ).toBe(true);
        expect(lookups).toBe(2);
        expect(materializations).toBe(2);
        expect(reports).toBe(1);
        expect(reportBodies).toHaveLength(1);
        expect(
          ConnectedAccountAuthFailureRequestV1Schema.parse(reportBodies[0]),
        ).toMatchObject({
          credentialContext: {
            account: {
              service,
              accountId: 'primary',
            },
            credentialRevision: initialServerMutation.credentialRevision,
          },
          normalizedFailure: {
            class: 'authentication',
            evidence: {
              httpStatus: 401,
              limitCategory: 'auth_invalid',
              quotaScope: 'unknown',
              evidenceSource: {
                kind: 'structured',
              },
            },
          },
        });
        expect(JSON.stringify(events)).toContain(
          'spawned current-owner recovery succeeded',
        );
        expect(JSON.stringify(events)).not.toContain(
          'invalid bearer token',
        );
        expect(
          recoveryScheduler.readForSession(
            'strict-spawned-host-session',
          ),
        ).toEqual([]);
        expect(recoveryBoundary).not.toHaveBeenCalled();
        expect(genericRuntimeAdapterInputs).toEqual([]);
        expect(continuationSendBoundary).not.toHaveBeenCalled();
        const oauthRefreshPosts = oauthRefreshRequests.filter(
          ({ method }) => method === 'POST',
        );
        expect(oauthRefreshPosts).toHaveLength(1);
        expect(
          new URLSearchParams(oauthRefreshPosts[0]!.body).get(
            'refresh_token',
          ),
        ).toBe('refresh-token-a');
        expect(qualifiedRefreshOwnerEffects).toEqual([
          {
            operation: 'mutateCredentialHealth',
            credentialRevision: initialServerMutation.credentialRevision,
          },
          {
            operation: 'readCredential',
            credentialRevision: initialServerMutation.credentialRevision,
          },
          {
            operation: 'acquireRefreshLease',
            acquired: true,
            credentialRevision: initialServerMutation.credentialRevision,
          },
          {
            operation: 'mutateCredential',
            credentialRevision,
          },
        ]);
        const persistedCredential =
          await api.getConnectedServiceCredentialPlain({
            serviceId: 'openai-codex',
            profileId: 'primary',
          });
        if (
          !persistedCredential
          || persistedCredential.revisionSemantics !== 'revisioned'
        ) {
          throw new Error('joined_topology_final_credential_unfenced');
        }
        expect(persistedCredential.credentialRevision).not.toBe(
          initialServerMutation.credentialRevision,
        );
        expect(persistedCredential.credentialRevision).toBe(
          credentialRevision,
        );
        expect(persistedCredential.content.v).toMatchObject({
          kind: 'oauth',
          oauth: {
            accessToken: rotatedAccessToken,
            refreshToken: 'refresh-token-b',
          },
        });
        expect(existsSync(joinedServer.dbPath)).toBe(true);
      } finally {
        try {
          await runtime?.dispose();
          abortController.abort();
          recoveryScheduler.dispose();
          await registry.retire(capability);
          sessionPurposeBindingLease.dispose();
          await pluginRuntimeRegistry.dispose();
          await app.close();
          const providerClosed = once(provider, 'close');
          provider.close();
          for (const socket of providerSockets) socket.destroy();
          await providerClosed;
          const oauthRefreshClosed = once(oauthRefreshServer, 'close');
          oauthRefreshServer.close();
          await oauthRefreshClosed;
          await joinedServer.stop();
          vi.unstubAllGlobals();
          if (previousOauthRefreshUrl === undefined) {
            delete process.env
              .HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL;
          } else {
            process.env
              .HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL =
              previousOauthRefreshUrl;
          }
          for (const key of serverSelectionEnvKeys) {
            const previous = previousServerSelectionEnv.get(key);
            if (previous === undefined) {
              delete process.env[key];
            } else {
              process.env[key] = previous;
            }
          }
          reloadConfiguration();
        } finally {
          await tlsFixture.cleanup();
          temporaryRoots.delete(tlsFixture.directoryPath);
        }
      }
    },
    120_000,
  );
});
