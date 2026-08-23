import { describe, expect, it } from 'vitest';

import { ingestCanonicalPluginManifest } from '../../../manifest/ingest';
import type { ActivationTarget } from './targets';
import { activationTargetMatchesContributionDemand, shouldActivateTargetAtStartup } from './targets';

function target(contributes: Record<string, unknown>, activationEvents: readonly string[] = []): ActivationTarget {
    const result = ingestCanonicalPluginManifest({
        schemaVersion: 2,
        id: 'acme.activation-target',
        version: '1.0.0',
        displayName: 'Activation Target',
        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.js' },
        contributes,
        ...(activationEvents.length > 0
            ? { activation: { events: activationEvents.map((kind) => ({ kind })) } }
            : {}),
    }, { sourceProvenance: 'registryCustodied' });
    if (!result.ok) throw new Error(result.diagnostics.map((entry) => entry.message).join('\n'));
    return {
        provenance: 'external', source: { kind: 'path' }, pluginId: result.manifest.id,
        manifestPath: '/tmp/plugin/happier.plugin.json',
        daemonEntryPath: '/tmp/plugin/daemon.js',
        sourceSpec: { kind: 'path', locator: '/tmp/plugin', trustPolicy: 'local_trusted', installPolicy: 'link' },
        activationEvents,
        manifest: result.manifest,
    };
}

describe('activation target demand', () => {
    it('routes speech demand through the unified Voice registration family', () => {
        const speech = target({
            voiceProviders: [{
                id: 'speech', title: 'Speech', kind: 'speech',
                roles: ['dictation_stt'], platforms: ['web'],
                settings: {
                    schemaVersion: 2,
                    fields: [{
                        id: 'model', title: 'Model',
                        schema: { type: 'string', minLength: 1, maxLength: 256 },
                        default: 'synthetic-stt-v1',
                        presentation: { control: 'text' },
                    }],
                },
            }],
        });

        expect(shouldActivateTargetAtStartup(speech)).toBe(false);
        expect(activationTargetMatchesContributionDemand(speech, {
            pluginId: speech.pluginId,
            family: 'voiceProviders',
            localId: 'speech',
        })).toBe(true);
        expect(activationTargetMatchesContributionDemand(speech, {
            pluginId: speech.pluginId,
            family: 'voiceProviders.speech',
            localId: 'speech',
        })).toBe(false);
    });

    it('leaves client Voice registration to the client artifact instead of daemon activation', () => {
        const voice = target({
            voiceProviders: [{
                id: 'conversation',
                title: 'Conversation',
                kind: 'conversation',
                roles: ['realtime_conversation'],
                platforms: ['web'],
                capabilities: {
                    turn: { cancelResponse: true, bargeIn: false },
                },
                client: {
                    artifactId: 'voice-runtime-web',
                    modulePath: './voiceRuntime',
                    exportName: 'activate',
                },
            }],
        });

        expect(shouldActivateTargetAtStartup(voice)).toBe(false);
        expect(activationTargetMatchesContributionDemand(voice, {
            pluginId: voice.pluginId,
            family: 'voiceProviders',
            localId: 'conversation',
        })).toBe(false);
    });

    it('keeps a descriptor-only daemon dormant', () => {
        expect(shouldActivateTargetAtStartup(target({
            resources: [{ id: 'status', kind: 'asset', path: 'status.txt', contentType: 'text/plain' }],
        }))).toBe(false);
    });

    it('keeps managed Providers dormant until exact public runtime demand', () => {
        const provider = {
            v: 1,
            id: 'gateway',
            name: 'Gateway',
            kind: 'aggregator',
            endpointTemplates: [{
                id: 'api',
                protocol: 'openai-responses',
                baseUrl: 'https://example.test/v1',
                capabilities: {
                    streaming: 'supported',
                    toolRoundTrips: 'supported',
                    statefulResponses: 'unknown',
                    reasoningControls: 'supported',
                },
            }],
            catalog: {
                source: 'static',
                manualModelPolicy: 'allowed',
                staticModels: [{ id: 'example', name: 'Example' }],
            },
        };
        const descriptorOnly = target({ providers: [provider] });
        const managed = target({
            providers: [{
                ...provider,
                managedRuntime: { kind: 'managed', endpointTemplateIds: ['api'] },
            }],
        });

        expect(shouldActivateTargetAtStartup(descriptorOnly)).toBe(false);
        expect(shouldActivateTargetAtStartup(managed)).toBe(false);
        expect(activationTargetMatchesContributionDemand(managed, {
            pluginId: managed.pluginId,
            family: 'providers',
            localId: 'gateway',
        })).toBe(true);
    });

    it('keeps a Composer attachment runtime dormant until a staged attachment demands it', () => {
        const attachment = target({
            composerAttachments: [{
                id: 'entry',
                title: 'Entry',
                icon: 'action',
                cardinality: 'many',
                valueSchema: {
                    type: 'object',
                    properties: { entryId: { type: 'string' } },
                    required: ['entryId'],
                    additionalProperties: false,
                },
                runtime: { resolveForDispatch: true },
            }],
        });

        expect(shouldActivateTargetAtStartup(attachment)).toBe(false);
        expect(activationTargetMatchesContributionDemand(attachment, {
            pluginId: attachment.pluginId,
            family: 'composerAttachments',
            localId: 'entry',
        })).toBe(true);
        expect(activationTargetMatchesContributionDemand(attachment, {
            pluginId: attachment.pluginId,
            family: 'composerAttachments',
            localId: 'undeclared',
        })).toBe(false);
    });

    it('keeps an action registration dormant until host-derived contribution demand', () => {
        expect(shouldActivateTargetAtStartup(target({
            actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
        }))).toBe(false);
    });

    it('keeps SCM registrations dormant now that the async catalog owns qualified demand and re-read', () => {
        expect(shouldActivateTargetAtStartup(target({
            scmBackends: [{ id: 'fixture', title: 'Fixture SCM', kind: 'git', capabilities: ['detect'] }],
        }))).toBe(false);
        expect(shouldActivateTargetAtStartup(target({
            scmHostingProviders: [{
                id: 'fixture-host',
                title: 'Fixture Host',
                kind: 'github',
                capabilities: ['detect'],
                authService: 'fixture-account',
            }],
            connectedAccountDescriptors: [{
                id: 'fixture-account',
                title: 'Fixture account',
                authentication: {
                    defaultModeId: 'oauth',
                    modes: [{
                        id: 'oauth',
                        kind: 'oauthDeviceCode',
                        outcomeReconciliation: 'providerCheck',
                    }],
                },
                capabilities: ['scmHostingToken'],
            }],
        }))).toBe(false);
    });

    it('keeps author connected-account runtimes dormant until exact qualified service demand', () => {
        const accounts = target({
            connectedAccountDescriptors: [{
                id: 'novel-service',
                title: 'Novel service',
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
                    }],
                },
            }],
        });

        expect(shouldActivateTargetAtStartup(accounts)).toBe(false);
        expect(activationTargetMatchesContributionDemand(accounts, {
            pluginId: 'acme.activation-target', family: 'connectedAccountDescriptors', localId: 'novel-service',
        })).toBe(true);
        expect(activationTargetMatchesContributionDemand(accounts, {
            pluginId: 'another.plugin', family: 'connectedAccountDescriptors', localId: 'novel-service',
        })).toBe(false);
    });

    it('keeps request interceptors dormant now that fetch owns qualified demand and re-read', () => {
        const interceptor = target({
            requestInterceptors: [{
                id: 'api-policy',
                origins: ['https://api.example.test'],
                methods: ['GET'],
                priority: 10,
            }],
        });
        expect(shouldActivateTargetAtStartup(interceptor)).toBe(false);
        expect(activationTargetMatchesContributionDemand(interceptor, {
            pluginId: interceptor.pluginId,
            family: 'requestInterceptors',
            localId: 'api-policy',
        })).toBe(true);
    });

    it('keeps notification-channel registrations dormant for exact daemon send demand', () => {
        const notifications = target({
            events: [{ id: 'review-ready-event', kind: 'event', title: 'Review ready' }],
            notifications: [{
                id: 'review-ready',
                kind: 'activity',
                title: 'Review ready',
                eventIds: ['review-ready-event'],
                defaultChannels: ['configured'],
            }],
            notificationChannels: [{
                id: 'configured',
                kind: 'webhook',
                title: 'Configured delivery',
                configurable: true,
                defaultEnabled: true,
            }],
        });

        expect(shouldActivateTargetAtStartup(notifications)).toBe(false);
        expect(activationTargetMatchesContributionDemand(notifications, {
            pluginId: notifications.pluginId,
            family: 'notificationChannels',
            localId: 'configured',
        })).toBe(true);
        expect(activationTargetMatchesContributionDemand(notifications, {
            pluginId: 'another.plugin',
            family: 'notificationChannels',
            localId: 'configured',
        })).toBe(false);
    });

    it('keeps MCP server registrations dormant for exact daemon service demand', () => {
        const mcp = target({
            mcp: {
                servers: [{ id: 'tools', title: 'Tools', kind: 'dynamic' }],
                discoverySources: [{ id: 'detector', title: 'Detector' }],
            },
        });

        expect(shouldActivateTargetAtStartup(mcp)).toBe(false);
        expect(activationTargetMatchesContributionDemand(mcp, {
            pluginId: mcp.pluginId,
            family: 'mcp.servers',
            localId: 'tools',
        })).toBe(true);
        expect(activationTargetMatchesContributionDemand(mcp, {
            pluginId: mcp.pluginId,
            family: 'mcp.servers',
            localId: 'undeclared',
        })).toBe(false);
    });

    it('keeps Agent registrations dormant until an asynchronous product consumer demands the Agent', () => {
        expect(shouldActivateTargetAtStartup(target({
            agents: [{
                id: 'fixture-agent',
                title: 'Fixture Agent',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                    sessions: {
                        open: ['create'],
                        delivery: ['newTurn'],
                        cancel: true,
                    },
                },
            }],
        }))).toBe(false);
    });

    it('supports explicit startup-only activation without inventing registration rights', () => {
        const startup = target({}, ['startup']);
        expect(shouldActivateTargetAtStartup(startup)).toBe(true);
    });

    it('activates declared background services at machine-runtime startup without author events', () => {
        const background = target({
            backgroundServices: [{ id: 'memory-indexer', title: 'Memory indexer' }],
        });

        expect(shouldActivateTargetAtStartup(background)).toBe(true);
        expect(activationTargetMatchesContributionDemand(background, {
            pluginId: background.pluginId,
            family: 'backgroundServices',
            localId: 'memory-indexer',
        })).toBe(true);
    });

    it('matches host demand against canonical registration rights rather than author events', () => {
        const action = target({
            actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], execution: { target: 'daemon' }, placementBindings: ['primary'], dangerLevel: 'safe' }],
        });
        expect(activationTargetMatchesContributionDemand(action, {
            pluginId: action.pluginId,
            family: 'actions',
            localId: 'run',
        })).toBe(true);
        expect(activationTargetMatchesContributionDemand(action, {
            pluginId: 'another.plugin',
            family: 'actions',
            localId: 'run',
        })).toBe(false);
    });
});
