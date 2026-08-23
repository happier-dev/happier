import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    ParsedPluginEventContributionV1,
    PluginHostAccessRequestV2,
    PluginSettingsContributionV2,
} from '@happier-dev/protocol';
import {
    accountSettingsParse,
    ingestPluginManifestV2,
    redactBugReportSensitiveText,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
    HttpService } from '@happier-dev/plugin-sdk/http';
import type {
    ManagedExecutableRef,
    ManagedServices } from '@happier-dev/plugin-sdk/managed-services';
import type {
    ExecService } from '@happier-dev/plugin-sdk/exec';
import type {
    SessionsService,
} from '@happier-dev/plugin-sdk/sessions';
import { PLUGIN_MANIFEST as CLAUDE_PLUGIN_MANIFEST } from '@happier-dev/plugins-claude';
import { PLUGIN_MANIFEST as CODEX_PLUGIN_MANIFEST } from '@happier-dev/plugins-codex';
import { createCodexNativeAppServerClient } from '@happier-dev/plugins-codex/agent/runtime/appServer/client';
import { PLUGIN_MANIFEST as OPENCODE_PLUGIN_MANIFEST } from '@happier-dev/plugins-opencode';
import { materializeOpenCodeAuthEnvironment } from '@happier-dev/plugins-opencode/agent/auth/services/materialize';
import { PLUGIN_MANIFEST as DEEPSEC_PLUGIN_MANIFEST } from '@happier-dev/plugins-review-deepsec';

import type { PluginInvocationLogRecord } from './logger';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';
import { createStablePluginMcpHost } from './mcp';
import { createProductionPluginInvocationServiceOwners } from './production';
import { createLoggerFilesystemAndEventsServiceBinding } from './factory';
import type { StablePluginResourcesOwner } from './resources';
import { createStablePluginHttpHost } from '@/plugins/runtime/fetch/service';
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
        target: Object.freeze({ kind: 'plugin', event: Object.freeze({ pluginId: 'acme.alpha', localId: 'changed' }) }),
    }),
]);
const settingsDeclaration: PluginSettingsContributionV2 = {
    id: 'preferences',
    version: 1,
    title: 'Preferences',
    target: { kind: 'plugin' },
    scope: 'daemon',
    fields: [{
        id: 'endpoint',
        title: 'Endpoint',
        schema: { type: 'string' },
        default: 'https://default.example',
    }],
    presentation: { sections: [], subagentSections: [] },
};

function parsedRequiredHostAccess(
    manifest: unknown,
): readonly PluginHostAccessRequestV2[] {
    const parsed = ingestPluginManifestV2(manifest);
    if (!parsed.ok) throw new Error('Expected fixture manifest to be valid');
    return parsed.manifest.hostAccess.required;
}

function requiredHostAccessRequests(
    manifest: unknown,
) {
    return parsedRequiredHostAccess(manifest).map((request) => ({
        request,
        required: true,
    } satisfies Readonly<{
        request: PluginHostAccessRequestV2;
        required: true;
    }>));
}

async function unavailableTestWebSocket(): Promise<never> {
    throw new PluginError({
        code: 'plugin_websocket_test_adapter_unavailable',
        message: 'WebSocket is unavailable in this HTTP request fixture',
    });
}

describe('production invocation service owners', () => {
    it('carries the daemon Composer content owner through the production service factory', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'happier-production-composer-content-'));
        const filesystemRoots = {
            pluginData: workspace,
            workspace,
            projects: new Map<string, string>(),
        };
        const bind = vi.fn(() => Object.freeze({
            capabilities: () => Object.freeze({
                'composer.mediaContent.v1': Object.freeze({ status: 'available' as const }),
            }),
            stageMedia: vi.fn(async () => {
                throw new Error('stageMedia was not expected in this production binding test');
            }),
        }));
        const ownerParams = {
            loggerSink: { write: () => {} },
            filesystemRoots,
            composerContent: { bind },
        } satisfies NonNullable<Parameters<typeof createProductionPluginInvocationServiceOwners>[0]>;

        try {
            const owners = createProductionPluginInvocationServiceOwners(ownerParams);
            const seed = Object.freeze({
                plugin: Object.freeze({ id: 'acme.media', version: '1.0.0' }),
                contribution: Object.freeze({
                    id: 'stage-photo',
                    qualifiedId: 'acme.media/actions/stage-photo',
                }),
                generation: '7',
                correlationId: 'production-composer-content',
                surface: 'cli' as const,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });
            const services = owners.createServices(seed, createLoggerFilesystemAndEventsServiceBinding(
                '7',
                'production-composer-content-binding',
                [{
                    request: {
                        id: 'workspace-read',
                        capability: 'filesystem',
                        reason: 'Stage media from the workspace',
                        scope: { locations: [{ root: 'workspace' }], access: ['read'] },
                    },
                    required: true,
                }],
                filesystemRoots,
            ));

            expect(services.availability('composerContent')).toEqual({ status: 'available' });
            expect(bind).toHaveBeenCalledWith(expect.objectContaining({
                seed,
                fileSystem: expect.objectContaining({ readFile: expect.any(Function) }),
            }));
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    it('stamps nested contributed Actions with the immediate plugin current materialization', async () => {
        const upstreamMaterialization = createPluginActionCallerMaterializationFixture(
            'acme.alpha',
            { materializationId: 'materialization-alpha-current' },
        ).materialization;
        const currentMaterialization = createPluginActionCallerMaterializationFixture(
            'acme.beta',
            { materializationId: 'materialization-beta-current' },
        ).materialization;
        const invokeContributedAction = vi.fn(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
        }));
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
            resolveCurrentPluginMaterializationRef: (pluginId) => (
                pluginId === 'acme.beta' ? currentMaterialization : null
            ),
        });
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'acme.beta', version: '1.0.0' }),
            contribution: Object.freeze({
                id: 'run',
                qualifiedId: 'acme.beta/actions/run',
            }),
            generation: '7',
            correlationId: 'nested-beta-to-gamma',
            surface: 'plugin' as const,
            caller: Object.freeze({
                kind: 'plugin' as const,
                pluginId: 'acme.alpha',
                contribution: Object.freeze({
                    id: 'launch',
                    qualifiedId: 'acme.alpha/actions/launch',
                }),
                materialization: upstreamMaterialization,
                originSurface: 'ui' as const,
            }),
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        const services = owners.createServices(
            seed,
            owners.createOrdinaryServiceBinding('7', 'nested-beta-to-gamma-binding'),
        );

        await expect(services.actions.execute(
            { pluginId: 'acme.gamma', localId: 'publish' },
            { title: 'Ready' },
        )).resolves.toEqual({ accepted: true });
        expect(invokeContributedAction).toHaveBeenCalledWith(expect.objectContaining({
            action: { pluginId: 'acme.gamma', localId: 'publish' },
            surface: 'plugin',
            originSurface: 'ui',
            caller: {
                kind: 'plugin',
                pluginId: 'acme.beta',
                contribution: {
                    id: 'run',
                    qualifiedId: 'acme.beta/actions/run',
                },
                materialization: currentMaterialization,
                originSurface: 'ui',
            },
        }));
    });

    it('fails closed for nested contributed Actions after the host materialization retires', async () => {
        const invokeContributedAction = vi.fn(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
        }));
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
            resolveCurrentPluginMaterializationRef: () => null,
        });
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'acme.beta', version: '1.0.0' }),
            contribution: Object.freeze({
                id: 'run',
                qualifiedId: 'acme.beta/actions/run',
            }),
            generation: '7',
            correlationId: 'retired-beta-to-gamma',
            surface: 'plugin' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        const services = owners.createServices(
            seed,
            owners.createOrdinaryServiceBinding('7', 'retired-beta-to-gamma-binding'),
        );

        await expect(services.actions.execute(
            { pluginId: 'acme.gamma', localId: 'publish' },
            { title: 'Ready' },
        )).rejects.toMatchObject({ code: 'plugin_action_caller_unavailable' });
        expect(invokeContributedAction).not.toHaveBeenCalled();
    });

    it('binds Provider operations to the exact invocation signal and currentness', async () => {
        const bind = vi.fn((binding: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>) => Object.freeze({
            connections: Object.freeze({
                describe: vi.fn(async () => ({
                    status: 'success' as const,
                    connections: [],
                    available: [],
                    availableTruncated: false,
                    discoveryCandidates: [],
                    discoveryCandidatesTruncated: false,
                    localInstallations: [],
                    diagnostics: [],
                    diagnosticsTruncated: false,
                })),
                mutate: vi.fn(),
                bindingStatus: vi.fn(),
            }),
            catalog: Object.freeze({
                probe: vi.fn(),
                listModels: vi.fn(),
                setModelLoad: vi.fn(),
                projectModels: vi.fn(),
                mutateModelSettings: vi.fn(),
            }),
            migrations: Object.freeze({
                preview: vi.fn(),
                confirm: vi.fn(),
                confirmConflict: vi.fn(),
            }),
        }));
        const current = vi.fn(() => true);
        const controller = new AbortController();
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            providers: { bind },
        });
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'acme.providers', version: '1.0.0' }),
            contribution: Object.freeze({
                id: 'run',
                qualifiedId: 'acme.providers/actions/run',
            }),
            generation: '7',
            correlationId: 'provider-service',
            surface: 'cli' as const,
            signal: controller.signal,
            isGenerationCurrent: current,
        });

        const services = owners.createServices(
            seed,
            owners.createOrdinaryServiceBinding('7', 'provider-service-binding'),
        );

        expect(services.availability('providers')).toEqual({ status: 'available' });
        expect(bind).toHaveBeenCalledOnce();
        const invocationBinding = bind.mock.calls[0]?.[0];
        expect(invocationBinding?.signal).toBe(controller.signal);
        expect(invocationBinding?.isCurrent()).toBe(true);
        expect(current).toHaveBeenCalledOnce();
        await expect(services.providers.connections.describe({})).resolves.toMatchObject({
            status: 'success',
        });

        const unavailable = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
        }).createServices(
            seed,
            owners.createOrdinaryServiceBinding('7', 'provider-service-unavailable-binding'),
        );
        expect(unavailable.availability('providers')).toEqual({
            status: 'unavailable',
            code: 'plugin_service_unavailable',
        });
        expect(() => unavailable.providers.connections.describe({})).toThrow();
    });

    it('binds Sessions only through a resolved Session HostAccess policy', () => {
        const sessions = Object.freeze({
            current: null,
            list: vi.fn(async () => ({ items: [] })),
            get: vi.fn(async () => null),
            watch: vi.fn(() => Object.freeze({ dispose() {} })),
            subagents: Object.freeze({
                capabilities: vi.fn(() => ({
                    list: { status: 'unavailable' as const, code: 'not_bound' },
                    observe: { status: 'unavailable' as const, code: 'not_bound' },
                    watch: { status: 'unavailable' as const, code: 'not_bound' },
                })),
                list: vi.fn(async () => ({ items: [] })),
                get: vi.fn(async () => null),
                observe: vi.fn(async () => { throw new Error('not_bound'); }),
                watch: vi.fn(() => Object.freeze({ dispose() {} })),
            }),
            external: Object.freeze({
                capabilities: vi.fn(async () => ({
                    list: { status: 'unavailable' as const, code: 'not_bound' },
                    attach: { status: 'unavailable' as const, code: 'not_bound' },
                    takeover: { status: 'unavailable' as const, code: 'not_bound' },
                    transcript: { status: 'unavailable' as const, code: 'not_bound' },
                    follow: { status: 'unavailable' as const, code: 'not_bound' },
                })),
                list: vi.fn(async () => ({ items: [], nextCursor: null })),
                attach: vi.fn(async () => { throw new Error('not_bound'); }),
                readTranscript: vi.fn(async () => { throw new Error('not_bound'); }),
                followTranscript: vi.fn(async () => ({
                    status: 'unavailable' as const,
                    code: 'not_bound',
                })),
                takeover: vi.fn(async () => { throw new Error('not_bound'); }),
            }),
        }) satisfies SessionsService;
        const bind = vi.fn(() => sessions);
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            sessions: { bind },
        });
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'acme.sessions', version: '1.0.0' }),
            contribution: Object.freeze({
                id: 'run',
                qualifiedId: 'acme.sessions/actions/run',
            }),
            generation: '7',
            correlationId: 'ordinary-sessions',
            surface: 'cli' as const,
            session: Object.freeze({ id: 'session-1' }),
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        const ordinaryBinding = owners.createOrdinaryServiceBinding('7', 'ordinary-sessions-binding');
        const ordinary = owners.createServices(seed, ordinaryBinding);

        expect(ordinary.availability('sessions')).toEqual({
            status: 'unavailable',
            code: 'plugin_service_unavailable',
        });
        expect(bind).not.toHaveBeenCalled();

        const policy = owners.resolveInvocationHostPolicy(action, {
            hostAccessRequests: [{
                required: true,
                request: {
                    id: 'project-sessions',
                    capability: 'sessions',
                    reason: 'Read project Sessions',
                    scope: {
                        access: ['read'],
                        machineIds: ['machine-a'],
                        projectIds: ['project-a'],
                    },
                },
            }],
            surface: 'cli',
            sessionId: seed.session.id,
        });
        const services = owners.createServices(seed, policy.serviceBinding);

        expect(services.availability('sessions')).toEqual({ status: 'available' });
        expect(services.sessions).toBe(sessions);
        expect(policy.serviceBinding.sessionScopes).toEqual([{
            access: ['read'],
            machineIds: ['machine-a'],
            projectIds: ['project-a'],
        }]);
        expect(bind).toHaveBeenCalledWith(seed, policy.serviceBinding, services.interactions, undefined);
    });

    it('shares invocation-local sequence ordering between plugin and host diagnostics', () => {
        const records: PluginInvocationLogRecord[] = [];
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: (record) => { records.push(record); } },
            now: () => 123,
        });
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'acme.voice', version: '1.0.0' }),
            contribution: Object.freeze({
                id: 'account-operation',
                qualifiedId: 'acme.voice/actions/account-operation',
            }),
            generation: '7',
            correlationId: 'shared-invocation-logger',
            surface: 'ui' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const services = owners.createServices(
            seed,
            owners.createOrdinaryServiceBinding('7', 'shared-invocation-logger-binding'),
        );

        services.logger.info('plugin log');
        owners.recordHostDiagnostic(seed, {
            code: 'plugin_voice_account_operation_response_rejected',
            severity: 'warning',
        });

        expect(records.map((record) => ({
            level: record.level,
            sequence: record.sequence,
            correlationId: record.context.correlationId,
        }))).toEqual([
            {
                level: 'info',
                sequence: 1,
                correlationId: 'shared-invocation-logger',
            },
            {
                level: 'diagnostic',
                sequence: 2,
                correlationId: 'shared-invocation-logger',
            },
        ]);
    });

    it('routes host diagnostics through the invocation-scoped redaction owner', () => {
        const records: PluginInvocationLogRecord[] = [];
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: (record) => { records.push(record); } },
            now: () => 123,
        });
        const controller = new AbortController();
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'acme.voice', version: '1.0.0' }),
            contribution: Object.freeze({
                id: 'account-operation',
                qualifiedId: 'acme.voice/actions/account-operation',
            }),
            generation: '7',
            correlationId: 'host-diagnostic-redaction',
            surface: 'ui' as const,
            signal: controller.signal,
            isGenerationCurrent: () => true,
        });
        owners.createServices(
            seed,
            owners.createOrdinaryServiceBinding('7', 'host-diagnostic-binding'),
        );
        owners.registerRawForRedaction(seed, 'registered-private-value');

        owners.recordHostDiagnostic(seed, {
            code: 'plugin_voice_account_operation_response_rejected',
            severity: 'warning',
            message: 'Voice account operation response rejected',
            details: {
                operationPurpose: 'registered-private-value',
                status: 422,
                contentType: 'undeclared',
                responseBodyBytes: 64,
                finalUrlMatches: true,
                responseContractMatches: false,
                bodyPolicyAccepted: null,
            },
        });

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            level: 'diagnostic',
            diagnostic: {
                code: 'plugin_voice_account_operation_response_rejected',
                details: {
                    operationPurpose: '[REDACTED]',
                    status: 422,
                    contentType: 'undeclared',
                    responseBodyBytes: 64,
                    finalUrlMatches: true,
                    responseContractMatches: false,
                    bodyPolicyAccepted: null,
                },
            },
        });
        controller.abort();
        owners.recordHostDiagnostic(seed, {
            code: 'late-host-diagnostic',
            severity: 'warning',
        });
        expect(records).toHaveLength(1);
    });

    it('releases repeated request-scoped redaction listeners without cross-request leakage', async () => {
        const records: PluginInvocationLogRecord[] = [];
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: (record) => { records.push(record); } },
        });

        for (let index = 0; index < 20; index += 1) {
            const controller = new AbortController();
            const addListener = vi.spyOn(controller.signal, 'addEventListener');
            const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
            const seed = Object.freeze({
                plugin: Object.freeze({ id: 'acme.settings', version: '1.0.0' }),
                contribution: Object.freeze({
                    id: 'settings',
                    qualifiedId: 'acme.settings/settings',
                }),
                generation: '7',
                correlationId: `settings-request-${index}`,
                surface: 'ui' as const,
                signal: controller.signal,
                isGenerationCurrent: () => true,
            });
            const services = owners.createServices(
                seed,
                owners.createOrdinaryServiceBinding('7', `settings-binding-${index}`),
            );
            const secret = `request-private-value-${index}`;
            owners.registerRawForRedaction(seed, secret);
            services.logger.info(secret);
            expect(records.at(-1)?.message).toBe('[REDACTED]');

            controller.abort();
            const settledRecordCount = records.length;
            services.logger.info(`late ${secret}`);
            owners.registerRawForRedaction(seed, `late-${secret}`);
            expect(records).toHaveLength(settledRecordCount);
            expect(owners.redactDiagnosticText({
                pluginId: seed.plugin.id,
                generation: seed.generation,
                correlationId: seed.correlationId,
            }, secret)).toBe(secret);
            expect(addListener).toHaveBeenCalledWith(
                'abort',
                expect.any(Function),
                { once: true },
            );
            expect(removeListener).toHaveBeenCalledWith(
                'abort',
                expect.any(Function),
            );
        }
        await owners.dispose();
    });

    it('releases the diagnostic scope when service construction fails', () => {
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
        });
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'acme.alpha', version: '1.2.3' }),
            contribution: Object.freeze({ id: 'run', qualifiedId: action.qualifiedId }),
            generation: '7',
            correlationId: 'construction-failure',
            surface: 'cli' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const wrongGenerationBinding = owners.createOrdinaryServiceBinding(
            '8',
            'wrong-generation-binding',
        );

        expect(() => owners.createServices(seed, wrongGenerationBinding)).toThrow();
        owners.registerRawForRedaction(seed, 'late-after-construction-failure');
        expect(owners.redactDiagnosticText({
            pluginId: seed.plugin.id,
            generation: seed.generation,
            correlationId: seed.correlationId,
        }, 'late-after-construction-failure')).toBe('late-after-construction-failure');
    });

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
                    target: { kind: 'plugin', event: 'measured-event' },
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
        const eventSubscription = services.events.plugin.subscribe(
            { pluginId: 'acme.measured', localId: 'measured-event' },
            async () => resolveEvent(),
        );
        await expect(services.events.plugin.emit('measured-event', { source: 'real-action' }))
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

    it('uses an exact retained-operation executable resolver instead of the current registry resolver', async () => {
        const currentResolver = vi.fn(async () => ({
            command: '/current-h-must-not-run',
        }));
        const retainedResolver = vi.fn(async () => ({
            command: process.execPath,
        }));
        const executable = {
            kind: 'managedDependency' as const,
            id: 'tool',
        };
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            exec: {
                resolveExecutable: currentResolver,
                resolvePath: async () => process.cwd(),
            },
        });
        const services = owners.createOperationServices({
            plugin: { id: 'acme.agent', version: '1.0.0' },
            contribution: {
                id: 'runner',
                qualifiedId: 'acme.agent/agents/runner',
            },
            generation: 'immutable-g',
            correlationId: 'retained-executable-g',
            surface: 'agent',
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
                    id: 'retained-process',
                    capability: 'process',
                    reason: 'Run the exact retained dependency',
                    scope: { executables: [executable] },
                },
            }],
            resolveExecutable: retainedResolver,
        });

        const result = await services.exec.run({
            executable,
            args: ['-e', "process.stdout.write('retained-g')"],
        });
        expect(Buffer.from(result.stdout).toString('utf8')).toBe(
            'retained-g',
        );
        expect(retainedResolver).toHaveBeenCalledOnce();
        expect(currentResolver).not.toHaveBeenCalled();
    });

    it('retires same-label operation resource owners by exact plugin identity', async () => {
        const unavailableResources = Object.freeze({
            describe(): never {
                throw new Error('resource access is not exercised');
            },
            async read(): Promise<never> {
                throw new Error('resource access is not exercised');
            },
            watch(): never {
                throw new Error('resource access is not exercised');
            },
        });
        const alphaRetirePlugin = vi.fn();
        const betaRetirePlugin = vi.fn();
        const resourceOwner = (
            pluginId: string,
            retirePlugin: (pluginId: string) => void,
        ): StablePluginResourcesOwner => Object.freeze({
            hasPlugin: (candidatePluginId) =>
                candidatePluginId === pluginId,
            getPluginUiResourceCapability: () => Object.freeze({ readable: false, dynamic: false }),
            getPluginBrandAsset: () => undefined,
            bind: () => unavailableResources,
            bindForResource: async () => unavailableResources,
            applySessionAccessWitness: () => {},
            retirePlugin,
        });
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
        });
        const operation = (resources: StablePluginResourcesOwner) => ({
            filesystemRoots: {
                pluginData: process.cwd(),
                workspace: process.cwd(),
                projects: new Map(),
            },
            hostAccessRequests: [],
            resources,
        });
        const seed = (pluginId: string) => ({
            plugin: { id: pluginId, version: '1.0.0' },
            contribution: {
                id: 'runner',
                qualifiedId: `${pluginId}/agents/runner`,
            },
            generation: 'shared-generation-label',
            correlationId: `resource-${pluginId}`,
            surface: 'agent' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        owners.createOperationServices(
            seed('acme.alpha'),
            operation(resourceOwner(
                'acme.alpha',
                alphaRetirePlugin,
            )),
        );
        owners.createOperationServices(
            seed('acme.beta'),
            operation(resourceOwner(
                'acme.beta',
                betaRetirePlugin,
            )),
        );

        await owners.retireGeneration(
            'shared-generation-label',
            'acme.alpha',
        );
        expect(alphaRetirePlugin).toHaveBeenCalledOnce();
        expect(alphaRetirePlugin).toHaveBeenCalledWith('acme.alpha');
        expect(betaRetirePlugin).not.toHaveBeenCalled();

        await owners.retireGeneration(
            'shared-generation-label',
            'acme.beta',
        );
        expect(betaRetirePlugin).toHaveBeenCalledOnce();
        expect(betaRetirePlugin).toHaveBeenCalledWith('acme.beta');
    });

    it('scopes inherited Codex environment defaults while diagnosing an explicit overlay mismatch', async () => {
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
        const records: PluginInvocationLogRecord[] = [];
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: (record) => { records.push(record); } },
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
                FOREIGN_SECRET: 'host-default-must-not-be-inherited',
            },
            hostAccessRequests: requiredHostAccessRequests(
                CODEX_PLUGIN_MANIFEST,
            ),
        });

        const overlayClient = await createCodexNativeAppServerClient({
            exec: services.exec,
            processEnv: {
                CODEX_HOME: codexHome,
                FOREIGN_SECRET: 'explicit-overlay-value',
            },
        });
        try {
            await expect(overlayClient.request('hooks/list', { cwds: [] })).resolves.toEqual({
                data: [],
                observedEnvironment: {
                    CODEX_HOME: codexHome,
                    FOREIGN_SECRET: 'explicit-overlay-value',
                },
            });
        } finally {
            await overlayClient.dispose();
        }
        expect(records).toContainEqual(expect.objectContaining({
            diagnostic: expect.objectContaining({
                code: 'plugin_host_access_disclosure_mismatch',
                details: {
                    capability: 'environment',
                    keys: ['FOREIGN_SECRET'],
                },
            }),
        }));

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
        const filesystemRequests = parsedRequiredHostAccess(manifest).filter((request) => (
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
            hostAccessRequests: requiredHostAccessRequests(manifest),
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
                materializationId: 'production-request-auth-exec',
                connectedAccountMaterializationAuthority: 'qualified',
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
                hostAccessRequests: requiredHostAccessRequests(
                    OPENCODE_PLUGIN_MANIFEST,
                ),
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
            discoverySources: [],
            activateOnDemand: async () => {},
            readServer: () => ({
                generation: '7', qualifiedId: 'acme.tools/runtime', isCurrent: () => true,
                listTools: async () => ({ items: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
                callTool: async ({ input }) => input,
                listResources: async () => ({ items: [] }),
                listResourceTemplates: async () => ({ items: [] }),
                readResource: async ({ uri }) => ({ contents: [{ uri, text: '' }] }),
                subscribeResource: async () => ({ dispose: async () => {} }),
                listPrompts: async () => ({ items: [] }),
                getPrompt: async () => ({ messages: [] }),
            }),
            readDiscoverySource: () => null,
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
                        discoverySourceRefs: [],
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
                        discoverySourceRefs: [],
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

        const undeclaredBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [],
            surface: 'cli',
        });
        if (!undeclaredBinding) throw new Error('Expected unavailable MCP host binding');
        const undeclaredServices = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1.2.3' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7', correlationId: 'undeclared-mcp-correlation', surface: 'cli',
            signal: new AbortController().signal, isGenerationCurrent: () => true,
        }, undeclaredBinding.serviceBinding);
        expect(undeclaredServices.availability('mcp')).toEqual({
            status: 'unavailable',
            code: 'plugin_host_access_declaration_missing',
        });
        await expect(undeclaredServices.mcp.list()).rejects.toMatchObject({
            code: 'plugin_host_access_declaration_missing',
            message: "Plugin service 'mcp' requires a manifest hostAccess declaration for 'mcp'",
        });

        await owners.dispose();
        await expect(client.listTools()).rejects.toMatchObject({ code: 'plugin_mcp_client_disposed' });
    });

    it('binds exact network authority and revalidates it before terminal fetch I/O', async () => {
        let authorized = true;
        const adapterRequest = vi.fn<HttpService['request']>(async (request) => {
            const redirects = request.url.endsWith('/redirect');
            const responseHeaders: Record<string, string> = {};
            if (redirects) responseHeaders.location = 'https://api.example.test/next';
            const headers: Readonly<Record<string, string>> = Object.freeze(responseHeaders);
            return Object.freeze({
                status: redirects ? 302 : 204,
                finalUrl: request.url,
                headers,
                body: new Uint8Array(),
            });
        });
        const adapter: HttpService = Object.freeze({
            request: adapterRequest,
            openWebSocket: unavailableTestWebSocket,
        });
        const finalPolicy = vi.fn(async () => {
            if (!authorized) throw new Error('network authority revoked');
        });
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            http: createStablePluginHttpHost({ adapter, revalidateFinalPolicy: finalPolicy }),
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
        expect(services.availability('http')).toEqual({ status: 'available' });
        expect(services).not.toHaveProperty('fetch');
        await expect(services.http.request({
            url: 'https://api.example.test/data', method: 'GET', redirect: 'error',
        })).resolves.toMatchObject({ status: 204 });
        expect(finalPolicy).toHaveBeenCalledOnce();
        expect(adapterRequest).toHaveBeenCalledOnce();

        await expect(services.http.request({
            url: 'https://api.example.test/redirect', method: 'GET', redirect: 'follow',
        })).rejects.toMatchObject({ code: 'plugin_fetch_redirect_follow_unavailable' });
        expect(finalPolicy).toHaveBeenCalledOnce();
        expect(adapterRequest).toHaveBeenCalledOnce();

        const redirect = await services.http.request({
            url: 'https://api.example.test/redirect', method: 'GET', redirect: 'manual',
        });
        expect(redirect).toMatchObject({
            status: 302,
            finalUrl: 'https://api.example.test/redirect',
            headers: { location: 'https://api.example.test/next' },
        });
        await expect(services.http.request({
            url: redirect.headers.location!, method: 'GET', redirect: 'manual',
        })).resolves.toMatchObject({ status: 204, finalUrl: 'https://api.example.test/next' });
        expect(finalPolicy).toHaveBeenCalledTimes(3);
        expect(adapterRequest).toHaveBeenCalledTimes(3);

        authorized = false;
        await expect(services.http.request({
            url: 'https://api.example.test/data', method: 'GET', redirect: 'error',
        })).rejects.toThrow('network authority revoked');
        expect(finalPolicy).toHaveBeenCalledTimes(4);
        expect(adapterRequest).toHaveBeenCalledTimes(3);

        authorized = true;
        const optionalBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{ required: false, request: networkRequest }],
            surface: 'cli',
        });
        if (!optionalBinding) throw new Error('Expected optional network host binding');
        const optionalServices = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1.2.3' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7', correlationId: 'optional-network-correlation', surface: 'cli',
            signal: new AbortController().signal, isGenerationCurrent: () => true,
        }, optionalBinding.serviceBinding);
        expect(optionalServices.availability('http')).toEqual({ status: 'available' });
        expect(optionalServices).not.toHaveProperty('fetch');
        await expect(optionalServices.http.request({
            url: 'https://api.example.test/data', method: 'GET', redirect: 'error',
        })).resolves.toMatchObject({ status: 204 });
    });

    it('makes HTTP available from the host adapter without requiring a network declaration', async () => {
        const adapterRequest = vi.fn<HttpService['request']>(async (request) => Object.freeze({
            status: 204,
            finalUrl: request.url,
            headers: Object.freeze({}),
            body: new Uint8Array(),
        }));
        const mismatches: unknown[] = [];
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            http: createStablePluginHttpHost({
                adapter: Object.freeze({
                    request: adapterRequest,
                    openWebSocket: unavailableTestWebSocket,
                }),
                recordDisclosureMismatch: ({ mismatch }) => { mismatches.push(mismatch); },
            }),
        });
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [],
            surface: 'cli',
        });
        expect(hostBinding).not.toBeNull();
        if (!hostBinding) return;
        const services = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1.2.3' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7', correlationId: 'network-no-declaration', surface: 'cli',
            signal: new AbortController().signal, isGenerationCurrent: () => true,
        }, hostBinding.serviceBinding);

        expect(services.availability('http')).toEqual({ status: 'available' });
        expect(services).not.toHaveProperty('fetch');
        await expect(services.http.request({
            url: 'https://outside-disclosure.example.test/data',
            method: 'GET',
            redirect: 'error',
        })).resolves.toMatchObject({ status: 204 });
        expect(mismatches).toEqual([{
            capability: 'network',
            origin: 'https://outside-disclosure.example.test',
            method: 'GET',
        }]);
        expect(adapterRequest).toHaveBeenCalledOnce();
    });

    it('binds the daemon notification owner without exposing a channel credential surface', async () => {
        const demands: string[] = [];
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            notifications: {
                categories: [{
                    pluginId: 'acme.alpha',
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
        const daemonSettings = alpha.settings.forScope({ kind: 'daemon' });
        await expect(daemonSettings.get('endpoint')).resolves.toBe('https://default.example');
        await expect(daemonSettings.set('endpoint', 'https://configured.example', { expectedRevision: '0' }))
            .resolves.toEqual({ scope: { kind: 'daemon' }, revision: '1' });

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

    it('binds Account Agent settings to the reserved record owner rather than the host preferences blob', async () => {
        const hostPreferencesOutsidePluginRecord = accountSettingsParse({
            codexBackendMode: 'appServer',
            unrelatedHostPreferenceV1: {
                source: 'fixture',
                revision: 99,
            },
        });
        let record: Readonly<{
            status: 'present';
            revision: number;
            values: Readonly<Record<string, string>>;
        }> = Object.freeze({
            status: 'present' as const,
            revision: 3,
            values: Object.freeze({ codexBackendMode: 'acp' }),
        });
        const watchers = new Set<(hint: Readonly<{ revision?: number }>) => void>();
        const readRecord = vi.fn(async () => record);
        const writeRecord = vi.fn(async (_model: unknown, request: unknown) => {
            expect(request).toEqual({
                expectedRevision: 3,
                values: { codexBackendMode: 'appServer' },
            });
            record = Object.freeze({
                status: 'present' as const,
                revision: 4,
                values: Object.freeze({ codexBackendMode: 'appServer' }),
            });
            return Object.freeze({ status: 'updated' as const, revision: 4 });
        });
        setActiveAccountSettingsSnapshot({
            source: 'cache',
            settings: hostPreferencesOutsidePluginRecord,
            settingsVersion: 3,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'production-settings-test',
        });
        try {
            const owners = createProductionPluginInvocationServiceOwners({
                loggerSink: { write: () => {} },
                accountSettingsRecordAdapter: {
                    isAvailable: () => true,
                    readRecord,
                    writeRecord,
                    watchRecord(_model, listener) {
                        watchers.add(listener);
                        return () => watchers.delete(listener);
                    },
                },
                settingsDeclarations: [{
                    pluginId: 'acme.alpha',
                    contribution: {
                        id: 'agent-settings',
                        version: 1,
                        title: 'Agent settings',
                        target: { kind: 'agent', agent: 'alpha' },
                        scope: 'account',
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
            const accountSettings = services.settings.forScope({ kind: 'account' });
            await expect(accountSettings.get('codexBackendMode')).resolves.toBe('acp');
            await expect(accountSettings.set('codexBackendMode', 'appServer', { expectedRevision: '3' }))
                .resolves.toEqual({ scope: { kind: 'account' }, revision: '4' });
            expect(writeRecord).toHaveBeenCalledTimes(1);
            const changes: unknown[] = [];
            const subscription = accountSettings.watch((change) => changes.push(change));
            await vi.waitFor(() => expect(watchers.size).toBe(1));
            record = Object.freeze({
                status: 'present' as const,
                revision: 5,
                values: Object.freeze({ codexBackendMode: 'acp' }),
            });
            for (const watcher of watchers) watcher({ revision: 5 });
            await vi.waitFor(() => expect(changes).toEqual([{
                scope: { kind: 'account' },
                revision: '5',
                changedIds: ['codexBackendMode'],
                values: { codexBackendMode: 'acp' },
            }]));
            expect(hostPreferencesOutsidePluginRecord).toMatchObject({
                codexBackendMode: 'appServer',
                unrelatedHostPreferenceV1: expect.any(Object),
            });
            await subscription.dispose();
        } finally {
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('revalidates stable secret access at each effect and redacts materialized values from logs', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-production-secrets-'));
        const records: PluginInvocationLogRecord[] = [];
        const savedSecret = 'materialized "secret"\nvalue';
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: (record) => { records.push(record); } },
            storagePaths: resolvePluginStorePaths({ happyHomeDir }),
            secretDeclarations: [{
                pluginId: 'acme.alpha',
                declaration: { id: 'webhook-token', custody: 'daemon' },
            }],
        });
        const services = owners.createServices(Object.freeze({
            plugin: Object.freeze({ id: 'acme.alpha', version: '1.2.3' }),
            contribution: Object.freeze({ id: 'run', qualifiedId: action.qualifiedId }),
            generation: '7', correlationId: 'secret-correlation', surface: 'cli',
            signal: new AbortController().signal, isGenerationCurrent: () => true,
        }), owners.createOrdinaryServiceBinding('7', 'declared-secret-binding'));

        expect(services.availability('secrets')).toEqual({ status: 'available' });
        await services.secrets.set('webhook-token', savedSecret);
        await expect(services.secrets.get('webhook-token')).resolves.toBe(savedSecret);
        services.logger.info('using saved secret', {
            raw: savedSecret,
            jsonEscaped: JSON.stringify(savedSecret).slice(1, -1),
            urlEncoded: encodeURIComponent(savedSecret),
            base64: Buffer.from(savedSecret).toString('base64'),
            base64url: Buffer.from(savedSecret).toString('base64url'),
            hex: Buffer.from(savedSecret).toString('hex'),
        });
        const serialized = JSON.stringify(records.at(-1));
        expect(serialized).not.toContain('materialized \\"secret\\"\\nvalue');
        expect(serialized).not.toContain('materialized%20%22secret%22%0Avalue');
        expect(serialized).not.toContain(Buffer.from(savedSecret).toString('base64'));
        expect(serialized).not.toContain(Buffer.from(savedSecret).toString('base64url'));
        expect(serialized).not.toContain(Buffer.from(savedSecret).toString('hex'));
        expect(serialized).toContain('[REDACTED]');

        await owners.retireGeneration('7', 'acme.alpha');
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
        subscriber.events.plugin.subscribe({ pluginId: 'acme.alpha', localId: 'changed' }, async (event) => {
            if (typeof event.payload !== 'number') throw new Error('Expected numeric payload');
            delivered.push(event.payload);
            if (event.payload === 1) {
                throw new Error('https://alice:listener-secret@example.test/path?token=query-secret');
            }
        });

        await publisher.events.plugin.emit('changed', 1);
        await publisher.events.plugin.emit('changed', 2);

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

    it('diagnoses filesystem disclosure mismatches without denying access to an available host root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-svc07-production-'));
        const records: PluginInvocationLogRecord[] = [];
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write: (record) => { records.push(record); } }, filesystemRoots: { pluginData: root, workspace: root, projects: new Map() } });
        const request = { id: 'fs-src', capability: 'filesystem' as const, reason: 'source', scope: { locations: [{ root: 'workspace' as const, pathPrefix: 'src' }], access: ['read' as const, 'write' as const] } };
        const hostBinding = await owners.resolveHostBinding(action, { hostAccessRequests: [{ request, required: true }], surface: 'cli' });
        expect(hostBinding?.action.hostAccess[0]).toMatchObject({ status: 'available' });
        const services = owners.createServices({ plugin: { id: 'acme.alpha', version: '1' }, contribution: { id: 'run', qualifiedId: action.qualifiedId }, generation: '7', correlationId: 'c', surface: 'cli', signal: new AbortController().signal, isGenerationCurrent: () => true }, hostBinding!.serviceBinding);
        expect(services.availability('fs')).toEqual({ status: 'available' });
        await services.fs.writeFile({ root: 'workspace', relativePath: 'src/a.bin' }, new Uint8Array([1]));
        await expect(services.fs.writeFile({ root: 'workspace', relativePath: 'other/a.bin' }, new Uint8Array([1]))).resolves.toBeUndefined();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            level: 'diagnostic',
            diagnostic: {
                code: 'plugin_host_access_disclosure_mismatch',
                severity: 'warning',
                details: {
                    capability: 'filesystem',
                    root: 'workspace',
                    relativePath: 'other/a.bin',
                    access: 'write',
                },
            },
        });
    });

    it('makes filesystem available from real host roots without requiring a declaration', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-svc07-no-declaration-'));
        const records: PluginInvocationLogRecord[] = [];
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: (record) => { records.push(record); } },
            filesystemRoots: { pluginData: root, workspace: root, projects: new Map() },
        });
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [],
            surface: 'cli',
        });
        expect(hostBinding).not.toBeNull();
        if (!hostBinding) return;
        const services = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7',
            correlationId: 'no-declaration',
            surface: 'cli',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, hostBinding.serviceBinding);

        expect(services.availability('fs')).toEqual({ status: 'available' });
        await expect(services.fs.writeFile(
            { root: 'workspace', relativePath: 'outside-disclosure.bin' },
            new Uint8Array([1]),
        )).resolves.toBeUndefined();
        expect(records[0]).toMatchObject({
            diagnostic: {
                code: 'plugin_host_access_disclosure_mismatch',
                details: { capability: 'filesystem' },
            },
        });
    });

    it('reports filesystem unavailable when the production root owner is absent', async () => {
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            eventDeclarationsByPluginId: new Map(),
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

    it('keeps usable filesystem roots available when one declaration also names an unavailable project root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-svc07-partial-project-binding-'));
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            filesystemRoots: { pluginData: root, workspace: root, projects: new Map() },
            eventDeclarationsByPluginId: new Map(),
            activePluginIds: new Set(),
        });
        const request = {
            id: 'fs-mixed-roots',
            capability: 'filesystem' as const,
            reason: 'Read a workspace and a project root when available',
            scope: {
                locations: [
                    { root: 'workspace' as const },
                    { root: 'project' as const, projectId: 'missing-project' },
                ],
                access: ['read' as const],
            },
        };
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [{ request, required: true }],
            surface: 'cli',
        });
        if (!hostBinding) throw new Error('Expected filesystem host binding');
        const services = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7', correlationId: 'partial-project-root', surface: 'cli',
            signal: new AbortController().signal, isGenerationCurrent: () => true,
        }, hostBinding.serviceBinding);

        expect(hostBinding.action.hostAccess).toEqual([
            expect.objectContaining({ id: request.id, status: 'available' }),
        ]);
        expect(services.availability('fs')).toEqual({ status: 'available' });
        await expect(services.fs.stat({ root: 'workspace', relativePath: '' })).resolves.toMatchObject({
            kind: 'directory',
        });
        await expect(services.fs.stat({
            root: 'project', projectId: 'missing-project', relativePath: '',
        })).rejects.toMatchObject({ code: 'plugin_fs_root_unavailable' });
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

    it('makes exec available from the host resolver without requiring a process declaration', async () => {
        const records: PluginInvocationLogRecord[] = [];
        const executable = { kind: 'systemTool' as const, id: 'fixture.node' };
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: (record) => { records.push(record); } },
            exec: {
                resolveExecutable: async () => ({ command: process.execPath, args: ['-e', ''] }),
                resolvePath: async () => { throw new Error('unexpected path'); },
            },
        });
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [],
            surface: 'cli',
        });
        expect(hostBinding).not.toBeNull();
        if (!hostBinding) return;
        const services = owners.createServices({
            plugin: { id: 'acme.alpha', version: '1' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7',
            correlationId: 'exec-no-declaration',
            surface: 'cli',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        }, hostBinding.serviceBinding);

        expect(services.availability('exec')).toEqual({ status: 'available' });
        await expect(services.exec.run({ executable })).resolves.toMatchObject({
            termination: { observed: { kind: 'exit', exitCode: 0 } },
        });
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            diagnostic: {
                code: 'plugin_host_access_disclosure_mismatch',
                details: { capability: 'process', executable },
            },
        });
    });

    it('assembles only the admitted canonical managedServices owner', async () => {
        const managedServices = Object.freeze({
            dependencies: Object.freeze({
                status: vi.fn(),
                ensure: vi.fn(),
                update: vi.fn(),
                remove: vi.fn(),
            }),
            supervise: vi.fn(),
        }) satisfies ManagedServices;
        const owner = Object.freeze({
            isAvailable: vi.fn(() => true),
            bind: vi.fn(() => managedServices),
        });
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            managedServices: owner,
        });
        const hostBinding = await owners.resolveHostBinding(action, {
            hostAccessRequests: [],
            surface: 'cli',
        });
        expect(hostBinding).not.toBeNull();
        if (!hostBinding) return;

        const seed = {
            plugin: { id: 'acme.alpha', version: '1' },
            contribution: {
                id: 'run',
                qualifiedId: action.qualifiedId,
            },
            generation: '7',
            correlationId: 'managed-services-production',
            surface: 'cli' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        };
        const services = owners.createServices(
            seed,
            hostBinding.serviceBinding,
        );

        expect(owner.isAvailable).toHaveBeenCalledWith({
            generation: '7',
            contributionQualifiedId: action.qualifiedId,
        });
        expect(owner.bind).toHaveBeenCalledWith(seed);
        expect(services.availability('managedServices')).toEqual({
            status: 'available',
        });
        expect(services.managedServices).toBe(managedServices);
    });

    it('binds packaged-runtime resolution, request-auth, and endpoint access to one exact managed Provider operation', async () => {
        const executable = Object.freeze({
            kind: 'packaged-runtime-binary' as const,
            directorySegments: Object.freeze(['tools', 'unpacked']),
            executableBaseName: 'gateway-runtime',
        });
        const managedServices = Object.freeze({
            dependencies: Object.freeze({
                status: vi.fn(),
                ensure: vi.fn(),
                update: vi.fn(),
                remove: vi.fn(),
            }),
            supervise: vi.fn(),
        }) satisfies ManagedServices;
        let boundExec: ExecService | null = null;
        let boundContext: Parameters<NonNullable<
            import('./managedServicesAdapter').ManagedServicesInvocationOwner['bindWithExec']
        >>[2] | null = null;
        const projection = Object.freeze({
            access: Object.freeze({
                endpointUrl: () => 'http://127.0.0.1:4312/v1',
                request: vi.fn(),
            }),
            isCurrent: () => true,
            cleanup: vi.fn(),
        });
        const projectManagedProviderEndpointAccess = vi.fn(
            async () => projection,
        );
        const owner = Object.freeze({
            isAvailable: vi.fn(() => true),
            bind: vi.fn(() => managedServices),
            bindWithExec: vi.fn((_seed, exec, context) => {
                boundExec = exec;
                boundContext = context;
                return managedServices;
            }),
            projectManagedProviderEndpointAccess,
        });
        const resolveExecutable = vi.fn(async (
            _executable: ManagedExecutableRef,
            _pluginId: string,
            _context?: unknown,
        ) => ({ command: process.execPath, args: ['-e', ''] }));
        let providerCurrent = true;
        let requestAuthCurrent = true;
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            managedServices: owner,
            exec: {
                resolveExecutable,
                resolvePath: async () => process.cwd(),
            },
        });
        const seed = {
            plugin: { id: 'acme.providers', version: '1' },
            contribution: {
                id: 'gateway',
                qualifiedId: 'acme.providers/providers/gateway',
            },
            generation: 'provider-q',
            correlationId: 'managed-provider-runtime-operation',
            surface: 'cli' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        };
        const invocation = owners
            .createManagedProviderRuntimeInvocationServices(seed, {
                filesystemRoots: {
                    pluginData: process.cwd(),
                    workspace: process.cwd(),
                    projects: new Map(),
                },
                managedProviderRuntime: {
                    realm: 'managedProviderStart',
                    providerLocalId: 'gateway',
                    requestAuth: {
                        realm: 'managedProviderStart',
                        capabilityPath:
                            '/private/runtime/request-auth-capability.json',
                        requestAuthUses: [{
                            purpose: 'provider.inference',
                            materialization: {
                                kind: 'httpHeaders',
                                origin: 'https://api.openai.com',
                                headerNames: ['authorization'],
                            },
                        }],
                        isCurrent: () => requestAuthCurrent,
                    },
                    isCurrent: () => providerCurrent,
                },
                hostAccessRequests: [],
            });

        expect(invocation).not.toBeNull();
        expect(boundContext).toMatchObject({
            managedProvider: {
                realm: 'managedProviderStart',
                providerLocalId: 'gateway',
            },
            requestAuth: {
                realm: 'managedProviderStart',
                capabilityPath:
                    '/private/runtime/request-auth-capability.json',
            },
        });
        const currentBoundContext = boundContext as Parameters<NonNullable<
            import('./managedServicesAdapter').ManagedServicesInvocationOwner['bindWithExec']
        >>[2] | null;
        if (!currentBoundContext) {
            throw new Error('Expected managed Provider binding context');
        }
        await boundExec!.run({ executable });
        expect(resolveExecutable).toHaveBeenCalledWith(
            executable,
            'acme.providers',
            expect.objectContaining({
                kind: 'managedProviderRuntime',
                pluginId: 'acme.providers',
                providerLocalId: 'gateway',
                contributionQualifiedId:
                    'acme.providers/providers/gateway',
                generation: 'provider-q',
            }),
        );
        const resolutionContext = resolveExecutable.mock.calls[0]?.[2] as
            | Readonly<{ isCurrent(): boolean }>
            | undefined;
        expect(resolutionContext?.isCurrent()).toBe(true);
        expect(currentBoundContext.requestAuth?.isCurrent()).toBe(true);
        providerCurrent = false;
        requestAuthCurrent = false;
        expect(resolutionContext?.isCurrent()).toBe(false);
        expect(currentBoundContext.requestAuth?.isCurrent()).toBe(false);

        await expect(invocation!.projectEndpointAccess({
            service: Object.freeze({}) as never,
            endpoints: [{
                endpointTemplateId: 'responses',
                servicePath: '/v1',
            }],
            signal: seed.signal,
            isCurrent: () => true,
        })).resolves.toBe(projection);
        expect(projectManagedProviderEndpointAccess).toHaveBeenCalledOnce();
    });

    it('checks ordinary managedServices availability against the contribution identity, not its binding id', () => {
        const managedServices = Object.freeze({
            dependencies: Object.freeze({
                status: vi.fn(),
                ensure: vi.fn(),
                update: vi.fn(),
                remove: vi.fn(),
            }),
            supervise: vi.fn(),
        }) satisfies ManagedServices;
        const owner = Object.freeze({
            isAvailable: vi.fn(({ contributionQualifiedId }: Readonly<{
                contributionQualifiedId: string;
            }>) => contributionQualifiedId === action.qualifiedId),
            bind: vi.fn(() => managedServices),
        });
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            managedServices: owner,
        });
        const seed = {
            plugin: { id: 'acme.alpha', version: '1' },
            contribution: { id: 'run', qualifiedId: action.qualifiedId },
            generation: '7',
            correlationId: 'ordinary-managed-services-production',
            surface: 'mcp' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        };

        const services = owners.createServices(
            seed,
            owners.createOrdinaryServiceBinding(
                seed.generation,
                `${seed.contribution.qualifiedId}:binding`,
                [],
                seed.contribution.qualifiedId,
            ),
        );

        expect(owner.isAvailable).toHaveBeenCalledWith({
            generation: '7',
            contributionQualifiedId: action.qualifiedId,
        });
        expect(services.availability('managedServices')).toEqual({
            status: 'available',
        });
    });

    it('redacts Connected Accounts credential components and reversible encodings from invocation logs', async () => {
        const records: PluginInvocationLogRecord[] = [];
        const environmentCredential = 'environment "credential"\nwith spaces';
        const fileCredential = 'file-credential-value';
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
                    account: Object.freeze({
                        service: Object.freeze({
                            pluginId: 'acme.alpha',
                            localId: 'account',
                        }),
                        accountId: 'account-1',
                    }),
                    target: Object.freeze({
                        kind: 'account' as const,
                        displayName: 'Account',
                    }),
                })),
                materialize: vi.fn(async (input) => {
                    if (input.request.kind === 'httpHeaders') {
                        return Object.freeze({
                            kind: 'httpHeaders' as const,
                            headers: Object.freeze({
                                authorization: 'Bearer synthetic-token-value',
                                'proxy-authorization': 'Basic dXNlcjpwYXNzd29yZA==',
                            }),
                        });
                    }
                    if (input.request.kind === 'environment') {
                        return Object.freeze({
                            kind: 'environment' as const,
                            env: Object.freeze({ UPSTREAM_CREDENTIAL: environmentCredential }),
                        });
                    }
                    return Object.freeze({
                        kind: 'files' as const,
                        files: Object.freeze({
                            credentials: new TextEncoder().encode(fileCredential),
                        }),
                    });
                }),
                listAccounts: async () => {
                    throw new Error('Connected Account listing is outside this fixture');
                },
                materializeListedAccount: async () => {
                    throw new Error('Exact-listed Connected Account materialization is outside this fixture');
                },
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
                        materializationKinds: [
                            'httpHeaders' as const,
                            'environment' as const,
                            'files' as const,
                        ],
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
            kind: 'httpHeaders',
            origin: 'https://api.example.test',
            headerNames: ['authorization', 'proxy-authorization'],
        });
        await services.connectedAccounts.materialize('upstream', {
            kind: 'environment',
            keys: ['UPSTREAM_CREDENTIAL'],
        });
        await services.connectedAccounts.materialize('upstream', {
            kind: 'files',
            fileIds: ['credentials'],
        });
        services.logger.info('credential representations', {
            rawHeader: 'Bearer synthetic-token-value',
            fragment: 'synthetic-token-value',
            headerBase64: Buffer.from('Bearer synthetic-token-value').toString('base64'),
            urlEncodedHeader: encodeURIComponent('Bearer synthetic-token-value'),
            jsonEscapedEnvironment: JSON.stringify(environmentCredential).slice(1, -1),
            urlEncodedEnvironment: encodeURIComponent(environmentCredential),
            environmentBase64: Buffer.from(environmentCredential).toString('base64'),
            fileBase64: Buffer.from(fileCredential).toString('base64'),
            decodedBasicUser: 'user',
            decodedBasicComponent: 'password',
            ordinary: 'bearer status remains ordinary',
        });

        const serialized = JSON.stringify(records.at(-1));
        expect(serialized).not.toContain('synthetic-token-value');
        expect(serialized).not.toContain('Bearer%20synthetic-token-value');
        expect(serialized).not.toContain(Buffer.from('Bearer synthetic-token-value').toString('base64'));
        expect(serialized).not.toContain('environment%20%22credential%22%0Awith%20spaces');
        expect(serialized).not.toContain('environment \\"credential\\"\\nwith spaces');
        expect(serialized).not.toContain(Buffer.from(environmentCredential).toString('base64'));
        expect(serialized).not.toContain(Buffer.from(fileCredential).toString('base64'));
        expect(serialized).toContain('"decodedBasicUser":"user"');
        expect(serialized).not.toContain('password');
        expect(serialized).toContain('bearer status remains ordinary');
        expect(serialized).toContain('[REDACTED]');
        const supportTail = redactBugReportSensitiveText(serialized);
        expect(supportTail).toContain('"decodedBasicUser":"user"');
        expect(supportTail).not.toContain('password');
        await owners.retireGeneration('7', 'acme.alpha');
    });

    it('keeps managedServices unavailable without a canonical owner', async () => {
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
        expect(services.availability('managedServices')).toMatchObject({ status: 'unavailable' });
    });
});
