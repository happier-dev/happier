import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    ParsedPluginEventContributionV1,
    PluginHostAccessRequestV2,
    PluginPermissionDeclarationV1,
    PluginSettingsContributionV2,
} from '@happier-dev/protocol';
import { accountSettingsParse } from '@happier-dev/protocol';
import type { FetchRuntimeServiceV1 } from '@/plugins/runtime/exec/privateContract';
import type { PluginManagedDependenciesService } from '@happier-dev/plugin-sdk/runtime';
import { PLUGIN_MANIFEST as CLAUDE_PLUGIN_MANIFEST } from '@happier-dev/plugins-claude';
import { PLUGIN_MANIFEST as CODEX_PLUGIN_MANIFEST } from '@happier-dev/plugins-codex';
import { createCodexNativeAppServerClient } from '@happier-dev/plugins-codex/agent/runtime/appServer/client';
import { PLUGIN_MANIFEST as OPENCODE_PLUGIN_MANIFEST } from '@happier-dev/plugins-opencode';
import { materializeOpenCodeAuthEnvironment } from '@happier-dev/plugins-opencode/agent/auth/services/materialize';
import { PLUGIN_MANIFEST as DEEPSEC_PLUGIN_MANIFEST } from '@happier-dev/plugins-review-deepsec';

import type { PluginInvocationLogRecord } from './logger';
import { createStablePluginMcpHost } from './mcp';
import { createProductionPluginInvocationServiceOwners } from './production';
import { createStablePluginFetchHost } from '@/plugins/runtime/fetch/service';
import { createPluginAgentCliReadinessService } from '@/plugins/runtime/context/agents';
import { createPluginExecSystemToolResolver } from '@/plugins/runtime/exec/system/tools/resolveGrant';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { HostRuntimeLimitMeasurementSample } from '@/agent/runtime/state/runtimeLimitMeasurement';

const action = Object.freeze({
    qualifiedId: 'acme.alpha/actions/run',
    pluginId: 'acme.alpha',
    localId: 'run',
    generation: '7',
    dangerLevel: 'safe',
    scopes: Object.freeze(['global']),
    surfaces: Object.freeze(['cli']),
    hostAccess: Object.freeze([]),
    input: Object.freeze({}),
    policyFingerprint: 'a'.repeat(64),
});
const eventDeclarations: readonly ParsedPluginEventContributionV1[] = Object.freeze([
    Object.freeze({ id: 'changed', kind: 'event', title: 'Changed' }),
]);
const subscriberDeclarations: readonly ParsedPluginEventContributionV1[] = Object.freeze([
    Object.freeze({
        id: 'watch-changed',
        kind: 'subscription',
        event: Object.freeze({ pluginId: 'acme.alpha', localId: 'changed' }),
    }),
]);
const subscriberPermissions: readonly PluginPermissionDeclarationV1[] = Object.freeze([
    Object.freeze({
        capability: 'events.plugin.subscribe',
        scope: 'acme.alpha',
        reason: 'Observe publisher events',
    }),
]);
const settingsDeclaration: PluginSettingsContributionV2 = {
    id: 'preferences',
    version: 1,
    title: 'Preferences',
    target: { kind: 'plugin' },
    scope: 'local',
    fields: [{
        id: 'endpoint',
        title: 'Endpoint',
        schema: { type: 'string' },
        default: 'https://default.example',
    }],
    presentation: { sections: [], subagentSections: [] },
};

describe('production invocation service owners', () => {
    it('routes one contribution action through measured event, protocol callback, stdout, and stderr owners', async () => {
        const executable = { kind: 'systemTool' as const, id: 'fixture.node' };
        const samples: HostRuntimeLimitMeasurementSample[] = [];
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            recordRuntimeLimitMeasurement(sample) {
                samples.push(sample);
                throw new Error('measurement failure must not change contribution semantics');
            },
            eventDeclarationsByPluginId: new Map([[
                'acme.measured',
                [{
                    id: 'measured-event',
                    kind: 'event',
                    title: 'Measured event',
                }, {
                    id: 'watch-measured-event',
                    kind: 'subscription',
                    event: 'measured-event',
                }],
            ]]),
            activePluginIds: new Set(['acme.measured']),
            exec: {
                resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => process.cwd(),
            },
        });
        const services = owners.createOperationServices({
            plugin: { id: 'acme.measured', version: '1.0.0' },
            contribution: {
                id: 'run',
                qualifiedId: 'acme.measured/actions/run',
            },
            generation: '7',
            correlationId: 'measured-action',
            surface: 'cli',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, {
            filesystemRoots: {
                pluginData: process.cwd(),
                workspace: process.cwd(),
                projects: new Map(),
            },
            environment: {},
            hostAccessRequests: [{
                required: true,
                request: {
                    id: 'fixture-process',
                    capability: 'process',
                    reason: 'Exercise canonical measured process services',
                    scope: { executables: [executable] },
                },
            }],
        });

        let resolveEvent!: () => void;
        const eventDelivered = new Promise<void>((resolve) => {
            resolveEvent = resolve;
        });
        const eventSubscription = services.events.subscribe(
            { pluginId: 'acme.measured', localId: 'measured-event' },
            async () => resolveEvent(),
        );
        await expect(services.events.emit('measured-event', { source: 'real-action' }))
            .resolves.toMatchObject({ status: 'admitted', subscriberCount: 1 });
        await eventDelivered;
        eventSubscription.dispose();

        const protocol = await services.exec.clients.spawn({
            kind: 'jsonStream',
            launch: {
                executable,
                args: ['-e', [
                    "process.stdin.once('data', () => {",
                    "process.stderr.write('measured-stderr');",
                    "process.stdout.write(JSON.stringify({ acknowledged: true }) + '\\n');",
                    'setTimeout(() => process.exit(0), 10);',
                    '});',
                ].join('')],
            },
            maxFrameBytes: 1024,
        });
        let resolveRecord!: (value: unknown) => void;
        const recordDelivered = new Promise<unknown>((resolve) => {
            resolveRecord = resolve;
        });
        const recordSubscription = protocol.client.subscribe(resolveRecord);
        await protocol.client.write({ trigger: true });
        await expect(recordDelivered).resolves.toEqual({ acknowledged: true });
        await expect(protocol.wait()).resolves.toMatchObject({
            termination: { observed: { kind: 'exit', exitCode: 0 } },
        });
        recordSubscription.dispose();
        await protocol.dispose();

        expect(new Set(samples.map((sample) => sample.family))).toEqual(new Set([
            'plugin-event-broker',
            'plugin-protocol-callbacks',
            'plugin-process-stdout',
            'plugin-process-stderr',
        ]));
        const callbackSample = samples
            .filter((sample) => sample.family === 'plugin-protocol-callbacks')
            .at(-1);
        const stdoutSample = samples
            .filter((sample) => sample.family === 'plugin-process-stdout')
            .at(-1);
        expect(callbackSample?.queuedBytes).toBeGreaterThan(0);
        expect(stdoutSample).toMatchObject({ backpressured: false });
        expect(stdoutSample?.queuedBytes).toBeGreaterThan(0);
        expect(samples.filter((sample) => sample.family === 'plugin-process-stderr').at(-1))
            .toMatchObject({ queuedBytes: 'measured-stderr'.length, backpressured: false });
    });

    it('admits Codex hooks/list with only the manifest-declared config root environment', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happier-codex-readiness-exec-'));
        const appServerFixture = join(workspace, 'codex-app-server-fixture.mjs');
        const codexHome = join(workspace, 'codex-home');
        await writeFile(appServerFixture, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('codex-cli 0.145.0\\n');
  process.exit(0);
}
if (args.length === 2 && args[0] === 'features' && args[1] === 'list') {
  process.exit(0);
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) continue;
    const result = message.method === 'hooks/list'
      ? {
          data: [],
          observedEnvironment: {
            CODEX_HOME: process.env.CODEX_HOME ?? null,
            FOREIGN_SECRET: process.env.FOREIGN_SECRET ?? null,
          },
        }
      : {};
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result,
    }) + '\\n');
  }
});
`, 'utf8');
        await chmod(appServerFixture, 0o755);
        const systemTools = createPluginExecSystemToolResolver({
            definitions: [{
                toolId: 'codex-cli',
                displayName: 'Codex CLI fixture',
                executablePath: appServerFixture,
            }],
            baseEnv: { PATH: '' },
            registerGrant: () => {},
        });
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            exec: {
                systemToolsForPlugin(pluginId) {
                    expect(pluginId).toBe(CODEX_PLUGIN_MANIFEST.id);
                    return systemTools;
                },
                resolveExecutable: async (executable, pluginId) => {
                    expect(pluginId).toBe(CODEX_PLUGIN_MANIFEST.id);
                    expect(executable).toEqual({ kind: 'systemTool', id: 'codex-cli' });
                    return {
                        command: process.execPath,
                        args: [appServerFixture],
                    };
                },
                resolvePath: async () => {
                    throw new Error('operation filesystem roots own cwd resolution');
                },
            },
        });
        const services = owners.createOperationServices({
            plugin: {
                id: CODEX_PLUGIN_MANIFEST.id,
                version: CODEX_PLUGIN_MANIFEST.version,
            },
            contribution: {
                id: 'codex',
                qualifiedId: `${CODEX_PLUGIN_MANIFEST.id}/agents/codex`,
            },
            generation: 'codex-readiness',
            correlationId: 'hooks-list',
            surface: 'agent',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, {
            filesystemRoots: {
                pluginData: workspace,
                workspace,
                projects: new Map(),
            },
            environment: {
                CODEX_HOME: codexHome,
                FOREIGN_SECRET: 'must-not-reach-codex',
            },
            hostAccessRequests: CODEX_PLUGIN_MANIFEST.hostAccess.required.map(
                (request) => ({ request, required: true }),
            ),
        });

        await expect(createCodexNativeAppServerClient({
            exec: services.exec,
            processEnv: {
                CODEX_HOME: codexHome,
                FOREIGN_SECRET: 'must-not-reach-codex',
            },
        })).rejects.toMatchObject({
            code: 'plugin_exec_environment_denied',
        });

        const client = await createCodexNativeAppServerClient({
            exec: services.exec,
            processEnv: { CODEX_HOME: codexHome },
        });
        try {
            await expect(client.request('hooks/list', { cwds: [] })).resolves.toEqual({
                data: [],
                observedEnvironment: {
                    CODEX_HOME: codexHome,
                    FOREIGN_SECRET: null,
                },
            });
        } finally {
            await client.dispose();
        }
    });

    it.each([
        ['Claude', CLAUDE_PLUGIN_MANIFEST, 'claude', 'claude-cli', 'claude-workspace'],
        ['Codex', CODEX_PLUGIN_MANIFEST, 'codex', 'codex-cli', 'codex-workspace'],
        ['DeepSec', DEEPSEC_PLUGIN_MANIFEST, 'deepsec', 'deepsec-cli', 'deepsec-workspace'],
        ['OpenCode', OPENCODE_PLUGIN_MANIFEST, 'opencode', 'opencode-cli', 'opencode-workspace'],
    ] as const)('authorizes the %s native launcher workspace from its declared host access', async (
        _name,
        manifest,
        agentId,
        systemToolId,
        workspaceAccessId,
    ) => {
        const filesystemRequests = manifest.hostAccess.required.filter((request) => (
            request.capability === 'filesystem'
        ));
        expect(filesystemRequests).toHaveLength(1);
        expect(filesystemRequests[0]).toMatchObject({
            id: workspaceAccessId,
            capability: 'filesystem',
        });
        expect(filesystemRequests[0]?.scope).toEqual({
            locations: [{ root: 'workspace' }],
            access: ['read'],
        });

        const workspace = await mkdtemp(join(tmpdir(), 'happier-agent-native-workspace-'));
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            exec: {
                resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => { throw new Error('static path resolver must not own operation cwd'); },
            },
        });
        const services = owners.createOperationServices({
            plugin: { id: manifest.id, version: manifest.version },
            contribution: {
                id: agentId,
                qualifiedId: `${manifest.id}/agents/${agentId}`,
            },
            generation: '7',
            correlationId: `workspace-${systemToolId}`,
            surface: 'agent',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, {
            filesystemRoots: {
                pluginData: workspace,
                workspace,
                projects: new Map(),
            },
            hostAccessRequests: manifest.hostAccess.required.map((request) => ({
                request,
                required: true,
            })),
        });

        await expect(services.exec.run({
            executable: { kind: 'systemTool', id: systemToolId },
            args: ['-e', ''],
            cwd: { root: 'workspace', relativePath: '' },
        })).resolves.toMatchObject({
            termination: { observed: { kind: 'exit', exitCode: 0 } },
        });
    });

    it('authorizes the request-auth environment consumed by the OpenCode child process', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-exec-'));
        try {
            const capabilityPath = join(workspace, 'request-auth', 'capability.json');
            const { env: materializedEnv } = await materializeOpenCodeAuthEnvironment({
                rootDir: workspace,
                requestAuth: {
                    capabilityPath,
                    purposeBindings: [{
                        purpose: {
                            consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
                            purpose: 'openai-codex-model-request',
                        },
                        target: {
                            kind: 'account',
                            account: {
                                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                                accountId: 'account-a',
                            },
                        },
                    }],
                },
            });
            const launchEnv = {
                XDG_CONFIG_HOME: materializedEnv.XDG_CONFIG_HOME,
                HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH:
                    materializedEnv.HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH,
            };
            expect(launchEnv).toEqual({
                XDG_CONFIG_HOME: expect.any(String),
                HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH: capabilityPath,
            });

            const owners = createProductionPluginInvocationServiceOwners({
                loggerSink: { write: () => {} },
                exec: {
                    resolveExecutable: async () => ({ command: process.execPath }),
                    resolvePath: async () => { throw new Error('static path resolver must not own operation cwd'); },
                },
            });
            const services = owners.createOperationServices({
                plugin: { id: OPENCODE_PLUGIN_MANIFEST.id, version: OPENCODE_PLUGIN_MANIFEST.version },
                contribution: {
                    id: 'opencode',
                    qualifiedId: `${OPENCODE_PLUGIN_MANIFEST.id}/agents/opencode`,
                },
                generation: '7',
                correlationId: 'opencode-request-auth-env',
                surface: 'agent',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            }, {
                filesystemRoots: {
                    pluginData: workspace,
                    workspace,
                    projects: new Map(),
                },
                hostAccessRequests: OPENCODE_PLUGIN_MANIFEST.hostAccess.required.map((request) => ({
                    request,
                    required: true,
                })),
            });

            const result = await services.exec.run({
                executable: { kind: 'systemTool', id: 'opencode-cli' },
                args: ['-e', 'process.stdout.write(JSON.stringify({'
                    + 'XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME,'
                    + 'HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH:'
                    + 'process.env.HAPPIER_CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH'
                    + '}))'],
                cwd: { root: 'workspace', relativePath: '' },
                env: launchEnv,
            });
            expect(Buffer.from(result.stdout).toString('utf8')).toBe(JSON.stringify(launchEnv));
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    it('binds an Agent operation workspace through the canonical filesystem and exec services', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happier-agent-operation-'));
        const executable = { kind: 'systemTool' as const, id: 'fixture.node' };
        const systemToolPath = join(workspace, 'fixture-tool');
        await writeFile(systemToolPath, '#!/bin/sh\nexit 0\n', 'utf8');
        await chmod(systemToolPath, 0o755);
        const agentCli = createPluginAgentCliReadinessService({
            processEnv: {
                HAPPIER_CLAUDE_PATH: systemToolPath,
                HAPPIER_HOME_DIR: workspace,
                PATH: '',
            },
        });
        const systemTools = createPluginExecSystemToolResolver({
            definitions: [{
                toolId: 'fixture.node',
                displayName: 'Fixture tool',
                executablePath: systemToolPath,
            }],
            baseEnv: { PATH: '' },
            registerGrant: () => {},
        });
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            exec: {
                agentCli,
                systemToolsForPlugin(pluginId) {
                    expect(pluginId).toBe('acme.agent');
                    return systemTools;
                },
                resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => { throw new Error('static path resolver must not own operation cwd'); },
            },
        });
        const services = owners.createOperationServices({
            plugin: { id: 'acme.agent', version: '1.2.3' },
            contribution: { id: 'reviewer', qualifiedId: 'acme.agent/agents/reviewer' },
            generation: '7',
            correlationId: 'run-1',
            surface: 'agent',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, {
            filesystemRoots: {
                pluginData: workspace,
                workspace,
                projects: new Map(),
            },
            environment: {
                FIXTURE_VALUE: 'admitted',
                UNDECLARED_SECRET: 'must-not-leak',
            },
            hostAccessRequests: [{
                required: true,
            request: {
                    id: 'workspace-read',
                    capability: 'filesystem',
                    reason: 'Use the admitted execution workspace',
                    scope: { locations: [{ root: 'workspace' }], access: ['read'] },
                },
            }, {
                required: true,
                request: {
                    id: 'review-process',
                    capability: 'process',
                    reason: 'Launch the admitted review tool',
                    scope: { executables: [executable], envKeys: ['FIXTURE_VALUE'] },
                },
            }],
        });

        expect(services.availability('fs')).toEqual({ status: 'available' });
        expect(services.availability('exec')).toEqual({ status: 'available' });
        await expect(services.exec.agentCli.checkReadiness({
            candidates: ['claude'],
            requirement: 'any',
            cwd: workspace,
        })).resolves.toEqual({ launchable: [{ agentId: 'claude' }] });
        await expect(services.exec.systemTools.resolve({
            toolId: 'fixture.node',
            purpose: 'pre-resolve the Agent operation tool',
            cwd: workspace,
        })).resolves.toMatchObject({ executable, executablePath: systemToolPath });
        const result = await services.exec.run({
            executable,
            args: ['-e', 'process.stdout.write(JSON.stringify({ cwd: process.cwd(), admitted: process.env.FIXTURE_VALUE, leaked: process.env.UNDECLARED_SECRET }))'],
            cwd: { root: 'workspace', relativePath: '' },
        });
        expect(result).toMatchObject({
            termination: { observed: { kind: 'exit', exitCode: 0 } },
        });
        const output = JSON.parse(Buffer.from(result.stdout).toString()) as Record<string, unknown>;
        await expect(realpath(String(output.cwd))).resolves.toBe(await realpath(workspace));
        expect(output).toEqual({ cwd: output.cwd, admitted: 'admitted' });
    });

    it('binds and disposes the stable daemon MCP owner through the production service surface', async () => {
        const loggerSink = vi.fn();
        const mcp = createStablePluginMcpHost({
            generation: '7',
            servers: [{
                provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.tools',
                definition: { id: 'runtime', title: 'Runtime tools', kind: 'dynamic' },
            }],
            discoveryProviders: [],
            activateOnDemand: async () => {},
            readServer: () => ({
                generation: '7', qualifiedId: 'acme.tools/runtime', isCurrent: () => true,
                listTools: async () => ({ items: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
                callTool: async ({ input }) => input,
            }),
            readDiscoveryProvider: () => null,
        });
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: loggerSink },
            mcp,
        });
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{
                required: true,
                request: {
                    id: 'runtime-mcp',
                    capability: 'mcp',
                    reason: 'Use the declared runtime tools',
                    scope: {
                        serverRefs: [{ pluginId: 'acme.tools', localId: 'runtime' }],
                        operations: ['listTools', 'callTools'],
                    },
                },
            }],
            surface: 'cli',
        });
        if (!hostBinding) throw new Error('Expected MCP-capable host binding');
        const services = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1.2.3' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7', correlationId: 'mcp-correlation', surface: 'cli',
            signal: new AbortController().signal, isGenerationCurrent: () => true,
        }, hostBinding.serviceBinding);

        expect(services.availability('logger')).toEqual({ status: 'available' });
        expect(services.availability('mcp')).toEqual({ status: 'available' });
        services.logger.info('mcp invocation path');
        expect(loggerSink).toHaveBeenCalledOnce();
        const client = await services.mcp.connect(
            { pluginId: 'acme.tools', localId: 'runtime' },
            { elicitation: { mode: 'reject' } },
        );
        await expect(client.callTool('echo', { value: 1 })).resolves.toEqual({ value: 1 });

        const deniedBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{
                required: false,
                request: {
                    id: 'runtime-mcp',
                    capability: 'mcp',
                    reason: 'Use the declared runtime tools',
                    scope: {
                        serverRefs: [{ pluginId: 'acme.tools', localId: 'runtime' }],
                        operations: ['listTools'],
                    },
                },
            }],
            surface: 'cli',
        });
        if (!deniedBinding) throw new Error('Expected denied MCP host binding');
        const deniedServices = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1.2.3' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7', correlationId: 'denied-mcp-correlation', surface: 'cli',
            signal: new AbortController().signal, isGenerationCurrent: () => true,
        }, deniedBinding.serviceBinding);
        expect(deniedServices.availability('mcp')).toEqual({
            status: 'denied',
            code: 'plugin_host_access_resource_not_selected',
        });
        await expect(deniedServices.mcp.list()).rejects.toMatchObject({
            code: 'plugin_host_access_resource_not_selected',
        });

        await owners.dispose();
        await expect(client.listTools()).rejects.toMatchObject({ code: 'plugin_mcp_client_disposed' });
    });

    it('binds exact network authority and revalidates it before terminal fetch I/O', async () => {
        let authorized = true;
        const adapter = vi.fn<FetchRuntimeServiceV1>(async (request) => {
            const redirects = request.url.endsWith('/redirect');
            const responseHeaders: Record<string, string> = {};
            if (redirects) responseHeaders.location = 'https://api.example.test/next';
            const headers: Readonly<Record<string, string>> = Object.freeze(responseHeaders);
            return Object.freeze({
                ok: true,
                status: redirects ? 302 : 204,
                statusText: redirects ? 'Found' : 'No Content',
                finalUrl: request.url,
                headers,
                body: null,
                text: async () => '',
                json: async () => null,
                arrayBuffer: async () => new ArrayBuffer(0),
            });
        });
        const finalPolicy = vi.fn(async () => {
            if (!authorized) throw new Error('network authority revoked');
        });
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            fetch: createStablePluginFetchHost({ adapter, revalidateFinalPolicy: finalPolicy }),
            filesystemRoots: {
                pluginData: '/tmp/plugin-data',
                workspace: '/tmp/workspace',
                projects: new Map(),
            },
        });
        const networkRequest: PluginHostAccessRequestV2 = {
            id: 'api-read',
            capability: 'network',
            reason: 'Read the declared API',
            scope: {
                targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }],
                methods: ['GET'],
            },
        };
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{ required: true, request: networkRequest }],
            surface: 'cli',
        });
        if (!hostBinding) throw new Error('Expected network-capable host binding');
        const services = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1.2.3' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7', correlationId: 'network-correlation', surface: 'cli',
            signal: new AbortController().signal, isGenerationCurrent: () => true,
        }, hostBinding.serviceBinding);

        expect(hostBinding.action.hostAccess).toEqual([
            expect.objectContaining({ id: 'api-read', status: 'available' }),
        ]);
        expect(services.availability('fetch')).toEqual({ status: 'available' });
        await expect(services.fetch.request({
            url: 'https://api.example.test/data', method: 'GET', redirect: 'error',
        })).resolves.toMatchObject({ status: 204 });
        expect(finalPolicy).toHaveBeenCalledOnce();
        expect(adapter).toHaveBeenCalledOnce();

        await expect(services.fetch.request({
            url: 'https://api.example.test/redirect', method: 'GET', redirect: 'follow',
        })).rejects.toMatchObject({ code: 'plugin_fetch_redirect_follow_unavailable' });
        expect(finalPolicy).toHaveBeenCalledOnce();
        expect(adapter).toHaveBeenCalledOnce();

        const redirect = await services.fetch.request({
            url: 'https://api.example.test/redirect', method: 'GET', redirect: 'manual',
        });
        expect(redirect).toMatchObject({
            status: 302,
            finalUrl: 'https://api.example.test/redirect',
            headers: { location: 'https://api.example.test/next' },
        });
        await expect(services.fetch.request({
            url: redirect.headers.location!, method: 'GET', redirect: 'manual',
        })).resolves.toMatchObject({ status: 204, finalUrl: 'https://api.example.test/next' });
        expect(finalPolicy).toHaveBeenCalledTimes(3);
        expect(adapter).toHaveBeenCalledTimes(3);

        authorized = false;
        await expect(services.fetch.request({
            url: 'https://api.example.test/data', method: 'GET', redirect: 'error',
        })).rejects.toThrow('network authority revoked');
        expect(finalPolicy).toHaveBeenCalledTimes(4);
        expect(adapter).toHaveBeenCalledTimes(3);

        const deniedBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{ required: false, request: networkRequest }],
            surface: 'cli',
        });
        if (!deniedBinding) throw new Error('Expected denied network host binding');
        const deniedServices = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1.2.3' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7', correlationId: 'denied-network-correlation', surface: 'cli',
            signal: new AbortController().signal, isGenerationCurrent: () => true,
        }, deniedBinding.serviceBinding);
        expect(deniedServices.availability('fetch')).toEqual({
            status: 'denied',
            code: 'plugin_host_access_resource_not_selected',
        });
        expect(() => deniedServices.fetch.request({
            url: 'https://api.example.test/data', method: 'GET', redirect: 'error',
        })).toThrow(expect.objectContaining({ code: 'plugin_host_access_resource_not_selected' }));
    });

    it('binds the daemon notification owner without exposing a channel credential surface', async () => {
        const demands: string[] = [];
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            notifications: {
                categories: [{
                    provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.alpha',
                    definition: {
                        id: 'review-ready', title: 'Review ready', kind: 'plugin', eventIds: ['review-ready-event'],
                        defaultChannels: ['configured'],
                    },
                }],
                channels: [{
                    provenance: 'external', source: { kind: 'path' }, pluginId: 'acme.alpha',
                    definition: { id: 'configured', title: 'Configured', kind: 'plugin', defaultEnabled: true },
                }],
                async activateChannel(ref) {
                    demands.push(`${ref.pluginId}/notificationChannels/${ref.localId}`);
                },
                readChannel(ref, seed) {
                    return {
                        generation: seed.generation,
                        isCurrent: () => true,
                        send: async (request) => ({
                            deliveryId: request.deliveryId,
                            channelId: request.channelId,
                            status: 'accepted',
                            evidence: 'hostAdapter',
                        }),
                    };
                },
            },
        });
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [],
            surface: 'cli',
        });
        if (!hostBinding) throw new Error('Expected notification-capable host binding');
        const services = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1.2.3' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7', correlationId: 'notification-correlation', surface: 'cli',
            signal: new AbortController().signal, isGenerationCurrent: () => true,
        }, hostBinding.serviceBinding);

        expect(services.availability('notifications')).toEqual({ status: 'available' });
        expect(Object.keys(services.notifications).sort()).toEqual([
            'listCategories', 'listChannels', 'preferences', 'send', 'watchPreferences',
        ]);
        await expect(services.notifications.send({
            clientRequestId: 'request-1', categoryId: 'review-ready', title: 'Ready',
        })).resolves.toEqual({
            replayed: false,
            deliveries: [expect.objectContaining({
                channelId: 'acme.alpha/configured', status: 'accepted', evidence: 'hostAdapter',
            })],
        });
        expect(demands).toEqual(['acme.alpha/notificationChannels/configured']);
    });

    it('binds the logger-enabled resolver to the matching services factory', async () => {
        const records: PluginInvocationLogRecord[] = [];
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: (record) => { records.push(record); } },
            now: () => 123,
            eventDeclarationsByPluginId: new Map(),
            permissionDeclarationsByPluginId: new Map(),
            activePluginIds: new Set(),
        });
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [],
            surface: 'cli',
        });
        expect(hostBinding).not.toBeNull();
        if (!hostBinding) return;

        const services = owners.createServices(Object.freeze({
            plugin: Object.freeze({ id: 'acme.alpha', version: '1.2.3' }),
            contribution: Object.freeze({ id: 'run', qualifiedId: 'acme.alpha/actions/run' }),
            generation: '7',
            correlationId: 'correlation-host-owned',
            surface: 'cli',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }), hostBinding.serviceBinding);

        expect(services.availability('logger')).toEqual({ status: 'available' });
        expect(services.availability('events')).toEqual({ status: 'available' });
        expect(services.availability('storage')).toMatchObject({ status: 'unavailable' });
        services.logger.info('production path');
        expect(records).toHaveLength(1);
    });

    it('marks settings available only for plugins with stable declarations', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-production-settings-'));
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            storagePaths: resolvePluginStorePaths({ happyHomeDir }),
            settingsDeclarations: Object.freeze([Object.freeze({
                pluginId: 'acme.alpha',
                contribution: settingsDeclaration,
            })]),
        });
        const alphaBinding = owners.createOrdinaryServiceBinding('7', 'alpha-binding');
        const alpha = owners.createServices(Object.freeze({
            plugin: Object.freeze({ id: 'acme.alpha', version: '1.2.3' }),
            contribution: Object.freeze({ id: 'run', qualifiedId: 'acme.alpha/actions/run' }),
            generation: '7', correlationId: 'alpha-settings', surface: 'cli',
            signal: new AbortController().signal, isGenerationCurrent: () => true,
        }), alphaBinding);

        expect(alpha.availability('settings')).toEqual({ status: 'available' });
        await expect(alpha.settings.get('endpoint')).resolves.toBe('https://default.example');
        await expect(alpha.settings.set('endpoint', 'https://configured.example', { expectedRevision: '0' }))
            .resolves.toEqual({ revision: '1' });

        const betaBinding = owners.createOrdinaryServiceBinding('7', 'beta-binding');
        const beta = owners.createServices(Object.freeze({
            plugin: Object.freeze({ id: 'acme.beta', version: '1.2.3' }),
            contribution: Object.freeze({ id: 'run', qualifiedId: 'acme.beta/actions/run' }),
            generation: '7', correlationId: 'beta-settings', surface: 'cli',
            signal: new AbortController().signal, isGenerationCurrent: () => true,
        }), betaBinding);
        expect(beta.availability('settings')).toEqual({
            status: 'unavailable',
            code: 'plugin_service_unavailable',
        });
    });

    it('binds synced Agent settings to the active account settings owner', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-production-agent-settings-'));
        setActiveAccountSettingsSnapshot({
            source: 'cache',
            settings: accountSettingsParse({ codexBackendMode: 'acp' }),
            settingsVersion: 3,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'production-settings-test',
        });
        try {
            const owners = createProductionPluginInvocationServiceOwners({
                loggerSink: { write: () => {} },
                storagePaths: resolvePluginStorePaths({ happyHomeDir }),
                settingsDeclarations: [{
                    pluginId: 'acme.alpha',
                    contribution: {
                        id: 'agent-settings',
                        version: 1,
                        title: 'Agent settings',
                        target: { kind: 'agent', agent: 'alpha' },
                        scope: 'synced',
                        fields: [{
                            id: 'codexBackendMode',
                            title: 'Backend mode',
                            schema: { type: 'string', enum: ['appServer', 'acp'] },
                        }],
                        presentation: { sections: [], subagentSections: [] },
                    },
                }],
            });
            const services = owners.createServices(Object.freeze({
                plugin: Object.freeze({ id: 'acme.alpha', version: '1.2.3' }),
                contribution: Object.freeze({ id: 'run', qualifiedId: 'acme.alpha/actions/run' }),
                generation: '7', correlationId: 'agent-settings', surface: 'cli',
                signal: new AbortController().signal, isGenerationCurrent: () => true,
            }), owners.createOrdinaryServiceBinding('7', 'agent-settings-binding'));

            expect(services.availability('settings')).toEqual({ status: 'available' });
            await expect(services.settings.get('codexBackendMode')).resolves.toBe('acp');
            const changes: unknown[] = [];
            const subscription = services.settings.watch((change) => changes.push(change));
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({
                    codexBackendMode: 'appServer',
                    pluginSettingsStateV1: {
                        'acme.alpha': {
                            t: 'happier_plugin_settings_record_v1',
                            revision: 1,
                        },
                    },
                }),
                settingsVersion: 4,
                loadedAtMs: 2,
                settingsSecretsReadKeys: [],
                scopeKey: 'production-settings-test',
            });
            await vi.waitFor(() => expect(changes).toEqual([{
                revision: '1',
                changedIds: ['codexBackendMode'],
                values: { codexBackendMode: 'appServer' },
            }]));
            await subscription.dispose();
        } finally {
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('revalidates stable secret access at each effect and redacts materialized values from logs', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-production-secrets-'));
        const records: PluginInvocationLogRecord[] = [];
        let authorized = true;
        const checks: string[] = [];
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: (record) => { records.push(record); } },
            storagePaths: resolvePluginStorePaths({ happyHomeDir }),
            async authorizeSecretAccess(effect) {
                checks.push(`${effect.pluginId}:${effect.secretId}:${effect.access}`);
                return authorized;
            },
        });
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{
                required: true,
                request: {
                    id: 'webhook-secret',
                    capability: 'secrets' as const,
                    reason: 'Send signed webhooks',
                    scope: {
                        secretIds: ['webhook-token'],
                        access: ['read', 'write', 'delete'] as ('read' | 'write' | 'delete')[],
                    },
                },
            }],
            surface: 'cli',
        });
        if (!hostBinding) throw new Error('Expected secret-capable host binding');
        const services = owners.createServices(Object.freeze({
            plugin: Object.freeze({ id: 'acme.alpha', version: '1.2.3' }),
            contribution: Object.freeze({ id: 'run', qualifiedId: action.qualifiedId }),
            generation: '7', correlationId: 'secret-correlation', surface: 'cli',
            signal: new AbortController().signal, isGenerationCurrent: () => true,
        }), hostBinding.serviceBinding);

        expect(services.availability('secrets')).toEqual({ status: 'available' });
        await services.secrets.set('webhook-token', 'materialized-secret');
        await expect(services.secrets.get('webhook-token')).resolves.toBe('materialized-secret');
        services.logger.info('using materialized-secret');
        expect(records.at(-1)?.message).toBe('using [REDACTED]');

        authorized = false;
        await expect(services.secrets.get('webhook-token')).rejects.toMatchObject({
            code: 'plugin_secret_access_denied',
        });
        expect(checks).toEqual([
            'acme.alpha:webhook-token:write',
            'acme.alpha:webhook-token:read',
            'acme.alpha:webhook-token:read',
        ]);
    });

    it('diagnoses throwing event listeners without interrupting later queued delivery', async () => {
        const records: PluginInvocationLogRecord[] = [];
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: {
                write(record) {
                    records.push(record);
                    throw new Error('diagnostic sink failed');
                },
            },
            now: () => 123,
            eventDeclarationsByPluginId: new Map([
                ['acme.alpha', eventDeclarations],
                ['acme.beta', subscriberDeclarations],
            ]),
            permissionDeclarationsByPluginId: new Map([
                ['acme.alpha', Object.freeze([])],
                ['acme.beta', subscriberPermissions],
            ]),
            activePluginIds: new Set(['acme.alpha', 'acme.beta']),
        });
        const publisherBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [],
            surface: 'cli',
        });
        const subscriberAction = Object.freeze({
            ...action,
            qualifiedId: 'acme.beta/actions/run',
            pluginId: 'acme.beta',
        });
        const subscriberBinding = await owners.resolveHostBinding(subscriberAction, {
            hostAccessRequests: [],
            surface: 'cli',
        });
        expect(publisherBinding).not.toBeNull();
        expect(subscriberBinding).not.toBeNull();
        if (!publisherBinding || !subscriberBinding) return;
        const publisher = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1.2.3' },
            contribution: { id: 'run', qualifiedId: 'acme.alpha/actions/run' },
            generation: '7',
            correlationId: 'correlation-publisher',
            surface: 'cli',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, publisherBinding.serviceBinding);
        const subscriber = owners.createServices({
            plugin: { id: 'acme.beta', version: '2.0.0' },
            contribution: { id: 'run', qualifiedId: 'acme.beta/actions/run' },
            generation: '7',
            correlationId: 'correlation-subscriber',
            surface: 'cli',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, subscriberBinding.serviceBinding);
        const delivered: number[] = [];
        subscriber.events.subscribe({ pluginId: 'acme.alpha', localId: 'changed' }, async (event) => {
            if (typeof event.payload !== 'number') throw new Error('Expected numeric payload');
            delivered.push(event.payload);
            if (event.payload === 1) {
                throw new Error('https://alice:listener-secret@example.test/path?token=query-secret');
            }
        });

        await publisher.events.emit('changed', 1);
        await publisher.events.emit('changed', 2);

        await vi.waitFor(() => expect(delivered).toEqual([1, 2]));
        await vi.waitFor(() => expect(records).toHaveLength(1));
        expect(records[0]).toMatchObject({
            level: 'diagnostic',
            context: {
                plugin: { id: 'acme.beta', version: '2.0.0' },
                contribution: { id: 'run', qualifiedId: 'acme.beta/actions/run' },
                generation: '7',
                correlationId: 'correlation-subscriber',
            },
            diagnostic: {
                code: 'plugin_event_listener_failed',
                severity: 'error',
                details: {
                    publisher: {
                        pluginId: 'acme.alpha',
                        generation: '7',
                        correlationId: 'correlation-publisher',
                    },
                },
            },
        });
        expect(JSON.stringify(records[0])).not.toContain('listener-secret');
        expect(JSON.stringify(records[0])).not.toContain('query-secret');
    });

    it('makes filesystem available only for the exact structured request scope', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-svc07-production-'));
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write: () => {} }, filesystemRoots: { pluginData: root, workspace: root, projects: new Map() } });
        const request = { id: 'fs-src', capability: 'filesystem' as const, reason: 'source', scope: { locations: [{ root: 'workspace' as const, pathPrefix: 'src' }], access: ['read' as const, 'write' as const] } };
        const hostBinding = await owners.resolveHostBinding(action, { hostAccessRequests: [{ request, required: true }], surface: 'cli' });
        expect(hostBinding?.action.hostAccess[0]).toMatchObject({ status: 'available' });
        const services = owners.createServices({ plugin: { id: 'acme.alpha', version: '1' }, contribution: { id: 'run', qualifiedId: action.qualifiedId }, generation: '7', correlationId: 'c', surface: 'cli', signal: new AbortController().signal, isGenerationCurrent: () => true }, hostBinding!.serviceBinding);
        expect(services.availability('fs')).toEqual({ status: 'available' });
        await services.fs.writeFile({ root: 'workspace', relativePath: 'src/a.bin' }, new Uint8Array([1]));
        await expect(services.fs.writeFile({ root: 'workspace', relativePath: 'other/a.bin' }, new Uint8Array([1]))).rejects.toMatchObject({ code: 'plugin_fs_access_denied' });
    });

    it('reports filesystem unavailable when the production root owner is absent', async () => {
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            eventDeclarationsByPluginId: new Map(),
            permissionDeclarationsByPluginId: new Map(),
            activePluginIds: new Set(),
        });
        const request = { id: 'fs-src', capability: 'filesystem' as const, reason: 'source', scope: { locations: [{ root: 'workspace' as const, pathPrefix: 'src' }], access: ['read' as const] } };
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{ request, required: true }],
            surface: 'cli',
        });
        const catalogBinding = owners.resolveHostPolicy(action, {
            hostAccessRequests: [{ request, required: true }],
            surface: 'catalog',
        });

        expect(hostBinding?.action.hostAccess[0]).toMatchObject({
            status: 'unavailable',
            code: 'plugin_host_access_service_unavailable',
        });
        expect(catalogBinding.action.hostAccess).toEqual(hostBinding?.action.hostAccess);
        expect(catalogBinding.serviceBinding.availability).toEqual(hostBinding?.serviceBinding.availability);
        const services = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7',
            correlationId: 'c',
            surface: 'cli',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, hostBinding!.serviceBinding);
        expect(services.availability('fs')).toMatchObject({ status: 'unavailable' });
    });

    it('does not approve a project filesystem request whose exact root is unavailable', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-svc07-project-binding-'));
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            filesystemRoots: { pluginData: root, workspace: root, projects: new Map() },
            eventDeclarationsByPluginId: new Map(),
            permissionDeclarationsByPluginId: new Map(),
            activePluginIds: new Set(),
        });
        const workspaceRequest = { id: 'fs-workspace', capability: 'filesystem' as const, reason: 'workspace', scope: { locations: [{ root: 'workspace' as const }], access: ['read' as const] } };
        const projectRequest = { id: 'fs-project', capability: 'filesystem' as const, reason: 'project', scope: { locations: [{ root: 'project' as const, projectId: 'missing-project' }], access: ['read' as const] } };
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [
                { request: workspaceRequest, required: true },
                { request: projectRequest, required: true },
            ],
            surface: 'cli',
        });

        expect(hostBinding?.action.hostAccess).toEqual([
            expect.objectContaining({ id: 'fs-workspace', status: 'available' }),
            expect.objectContaining({ id: 'fs-project', status: 'unavailable' }),
        ]);
    });

    it('binds process authority only when the production executable resolver exists', async () => {
        const executable = { kind: 'systemTool' as const, id: 'fixture.node' };
        const request = {
            id: 'process',
            capability: 'process' as const,
            reason: 'Run fixture',
            scope: { executables: [executable] },
        };
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            exec: {
                resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => { throw new Error('unexpected path'); },
            },
        });

        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{ request, required: true }],
            surface: 'cli',
        });

        expect(hostBinding?.action.hostAccess[0]).toMatchObject({ status: 'available' });
        const services = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7',
            correlationId: 'exec-production',
            surface: 'cli',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, hostBinding!.serviceBinding);
        expect(services.availability('exec')).toEqual({ status: 'available' });
    });

    it('binds managed supervision to declared process authority and joins generation retirement', async () => {
        const executable = { kind: 'systemTool' as const, id: 'fixture.server' };
        const request = {
            id: 'managed-server-process',
            capability: 'process' as const,
            reason: 'Run the declared managed server',
            scope: { executables: [executable] },
        };
        const dependencies: PluginManagedDependenciesService = Object.freeze({
            status: async (id: string) => Object.freeze({ state: 'unsupported' as const, id, code: 'fixture_not_installed' }),
            ensure: async () => { throw new Error('fixture dependency ensure unavailable'); },
            update: async () => { throw new Error('fixture dependency update unavailable'); },
            remove: async () => undefined,
        });
        let nextInstanceId = 0;
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            exec: {
                resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => { throw new Error('unexpected path'); },
            },
            managed: {
                dependencies,
                createInstanceId: () => `managed-instance-${++nextInstanceId}`,
            },
        });
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{ request, required: true }],
            surface: 'cli',
        });
        expect(hostBinding).not.toBeNull();
        if (!hostBinding) return;
        const services = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7',
            correlationId: 'managed-production',
            surface: 'cli',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, hostBinding.serviceBinding);

        expect(services.availability('managed')).toEqual({ status: 'available' });
        const first = await services.managed.servers.supervise({
            id: 'external',
            mode: { kind: 'externalAttach', baseUrl: 'http://127.0.0.1:49152' },
        });
        const joined = await services.managed.servers.supervise({
            id: 'external',
            mode: { kind: 'externalAttach', baseUrl: 'http://127.0.0.1:49152' },
        });
        expect(joined).toBe(first);
        expect(first.snapshot().instanceId).toBe('managed-instance-1');

        await owners.retireGeneration('7', 'acme.alpha');
        expect(first.snapshot().state).toBe('stopped');
        await expect(services.managed.servers.supervise({
            id: 'after-retirement',
            mode: { kind: 'externalAttach', baseUrl: 'http://127.0.0.1:49153' },
        })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
    });

    it('binds dependency status and executable resolution to the invoking plugin identity', async () => {
        const executable = { kind: 'managedDependency' as const, id: 'fixture-tool' };
        const boundPluginIds: string[] = [];
        const resolvedPluginIds: string[] = [];
        const dependencies: PluginManagedDependenciesService = Object.freeze({
            status: async (id: string) => Object.freeze({ state: 'missing' as const, id, supported: true as const }),
            ensure: async () => { throw new Error('not expected'); },
            update: async () => { throw new Error('not expected'); },
            remove: async () => {},
        });
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            exec: {
                resolveExecutable: async (_ref, pluginId) => {
                    resolvedPluginIds.push(pluginId);
                    return { command: process.execPath };
                },
                resolvePath: async () => { throw new Error('unexpected path'); },
            },
            managed: {
                dependenciesHost: {
                    bind(pluginId) {
                        boundPluginIds.push(pluginId);
                        return dependencies;
                    },
                },
            },
        });
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{
                request: {
                    id: 'managed-dependency-process',
                    capability: 'process',
                    reason: 'Run declared managed dependency',
                    scope: { executables: [executable] },
                },
                required: true,
            }],
            surface: 'cli',
        });
        if (!hostBinding) throw new Error('Expected production host binding');
        const services = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7',
            correlationId: 'managed-dependency-production',
            surface: 'cli',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, hostBinding.serviceBinding);

        await expect(services.managed.dependencies.status('fixture-tool')).resolves.toMatchObject({ state: 'missing' });
        await services.exec.run({ executable, args: ['-e', ''] });
        expect(boundPluginIds).toEqual(['acme.alpha']);
        expect(resolvedPluginIds).toEqual(['acme.alpha']);
    });

    it('redacts Connected Accounts materialization values from invocation logs', async () => {
        const records: PluginInvocationLogRecord[] = [];
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: (record) => { records.push(record); } },
            connectedAccounts: {
                getBinding: vi.fn(async () => null),
                requestSelection: vi.fn(async () => Object.freeze({
                    purpose: 'upstream',
                    service: Object.freeze({
                        pluginId: 'acme.alpha',
                        localId: 'account',
                    }),
                    target: Object.freeze({
                        kind: 'account' as const,
                        displayName: 'Account',
                    }),
                })),
                materialize: vi.fn(async () => Object.freeze({
                    kind: 'environment' as const,
                    env: Object.freeze({ UPSTREAM_TOKEN: 'connected-account-secret' }),
                })),
                watch: vi.fn(() => Object.freeze({ dispose() {} })),
            },
        });
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{
                required: true,
                request: {
                    id: 'upstream',
                    capability: 'connectedAccounts' as const,
                    reason: 'Use the selected upstream account',
                    scope: {
                        serviceRefs: ['account'],
                        operations: ['use' as const],
                        materializationKinds: ['environment' as const],
                    },
                },
            }],
            surface: 'cli',
        });
        if (!hostBinding) throw new Error('Expected Connected Accounts host binding');
        const services = owners.createServices(Object.freeze({
            plugin: Object.freeze({ id: 'acme.alpha', version: '1.2.3' }),
            contribution: Object.freeze({ id: 'run', qualifiedId: action.qualifiedId }),
            generation: '7',
            correlationId: 'connected-account-redaction',
            surface: 'cli',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }), hostBinding.serviceBinding);

        await services.connectedAccounts.materialize('upstream', {
            kind: 'environment',
            keys: ['UPSTREAM_TOKEN'],
        });
        services.logger.info('using connected-account-secret');

        expect(records.at(-1)?.message).toBe('using [REDACTED]');
    });

    it('joins every managed server generation when the production owner is disposed', async () => {
        const executable = { kind: 'systemTool' as const, id: 'fixture.server' };
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            exec: {
                resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => { throw new Error('unexpected path'); },
            },
            managed: {
                dependencies: Object.freeze({
                    status: async (id: string) => Object.freeze({ state: 'unsupported' as const, id, code: 'fixture_not_installed' }),
                    ensure: async () => { throw new Error('fixture dependency ensure unavailable'); },
                    update: async () => { throw new Error('fixture dependency update unavailable'); },
                    remove: async () => undefined,
                }),
                createInstanceId: () => 'managed-instance-dispose',
            },
        });
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{
                request: {
                    id: 'managed-server-process',
                    capability: 'process',
                    reason: 'Run the declared managed server',
                    scope: { executables: [executable] },
                },
                required: true,
            }],
            surface: 'cli',
        });
        if (!hostBinding) throw new Error('Expected production host binding');
        const services = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7',
            correlationId: 'managed-owner-dispose',
            surface: 'cli',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, hostBinding.serviceBinding);
        const server = await services.managed.servers.supervise({
            id: 'external',
            mode: { kind: 'externalAttach', baseUrl: 'http://127.0.0.1:49152' },
        });

        await owners.dispose();

        expect(server.snapshot().state).toBe('stopped');
    });

    it('makes concurrent aggregate disposal join the same managed cleanup', async () => {
        const executable = { kind: 'systemTool' as const, id: 'fixture.server' };
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            exec: {
                resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => { throw new Error('unexpected path'); },
            },
            managed: {
                dependencies: Object.freeze({
                    status: async (id: string) => Object.freeze({ state: 'unsupported' as const, id, code: 'fixture_not_installed' }),
                    ensure: async () => { throw new Error('fixture dependency ensure unavailable'); },
                    update: async () => { throw new Error('fixture dependency update unavailable'); },
                    remove: async () => undefined,
                }),
                createInstanceId: () => 'managed-instance-concurrent-dispose',
            },
        });
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{
                request: {
                    id: 'managed-server-process',
                    capability: 'process',
                    reason: 'Run the declared managed server',
                    scope: { executables: [executable] },
                },
                required: true,
            }],
            surface: 'cli',
        });
        if (!hostBinding) throw new Error('Expected production host binding');
        const services = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7',
            correlationId: 'managed-owner-concurrent-dispose',
            surface: 'cli',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, hostBinding.serviceBinding);
        const server = await services.managed.servers.supervise({
            id: 'managed',
            mode: { kind: 'managedSpawn', host: '127.0.0.1', port: 49152 },
            launch: {
                executable,
                args: ['-e', 'setInterval(() => {}, 1000)'],
            },
        });

        const firstDisposal = owners.dispose();
        await owners.dispose();
        const stateAfterSecondDisposal = server.snapshot().state;
        await firstDisposal;

        expect(stateAfterSecondDisposal).toBe('stopped');
        expect(server.snapshot().state).toBe('stopped');
    });

    it('selects a loopback port for production managed servers when the plugin leaves it unspecified', async () => {
        const executable = { kind: 'systemTool' as const, id: 'fixture.server' };
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            exec: {
                resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => { throw new Error('unexpected path'); },
            },
            managed: {
                dependencies: Object.freeze({
                    status: async (id: string) => Object.freeze({ state: 'unsupported' as const, id, code: 'fixture_not_installed' }),
                    ensure: async () => { throw new Error('fixture dependency ensure unavailable'); },
                    update: async () => { throw new Error('fixture dependency update unavailable'); },
                    remove: async () => undefined,
                }),
                createInstanceId: () => 'managed-instance-default-port',
            },
        });
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{
                request: {
                    id: 'managed-server-process',
                    capability: 'process',
                    reason: 'Run the declared managed server',
                    scope: { executables: [executable] },
                },
                required: true,
            }],
            surface: 'cli',
        });
        if (!hostBinding) throw new Error('Expected production host binding');
        const services = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7',
            correlationId: 'managed-owner-default-port',
            surface: 'cli',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, hostBinding.serviceBinding);

        const server = await services.managed.servers.supervise({
            id: 'managed',
            mode: { kind: 'managedSpawn', host: '127.0.0.1' },
            launch: {
                executable,
                args: ['-e', 'setInterval(() => {}, 1000)'],
            },
        });

        expect(server.snapshot()).toMatchObject({
            port: expect.any(Number),
            baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
            state: 'healthy',
        });
        expect(server.snapshot().port).toBeGreaterThan(0);

        await owners.dispose();
        expect(server.snapshot().state).toBe('stopped');
    });

    it('keeps managed unavailable without both dependency and executable host resolvers', async () => {
        const executable = { kind: 'systemTool' as const, id: 'fixture.server' };
        const request = {
            id: 'managed-server-process',
            capability: 'process' as const,
            reason: 'Run the declared managed server',
            scope: { executables: [executable] },
        };
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            exec: {
                resolveExecutable: async () => ({ command: process.execPath }),
                resolvePath: async () => { throw new Error('unexpected path'); },
            },
        });
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{ request, required: true }],
            surface: 'cli',
        });
        expect(hostBinding).not.toBeNull();
        if (!hostBinding) return;
        const services = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7',
            correlationId: 'managed-unavailable',
            surface: 'cli',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, hostBinding.serviceBinding);

        expect(services.availability('exec')).toEqual({ status: 'available' });
        expect(services.availability('managed')).toMatchObject({ status: 'unavailable' });
    });
});
