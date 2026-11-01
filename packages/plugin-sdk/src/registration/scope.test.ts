import { describe, expect, it, vi } from 'vitest';
import {
    VoiceProviderContributionSchema,
    type VoiceProviderContribution,
} from '@happier-dev/protocol';

import { createPluginRegistrationScope } from './scope.js';
import type {
    BackendRuntime,
    ComposerReferenceRuntime,
    HostingProviderRuntime,
    PluginMcpServerRuntime,
} from '../activation.js';
import type { PluginInvocationContext } from '../invocation.js';
import type { ManagedProviderRuntime } from '../managed-services/contract.js';
import type { VoiceProvidersRegistrationApi } from '../voice/projections.js';
import type {
    VoiceSpeechOperationContext,
    VoiceSpeechSynthesizeRequest,
} from '../voice/speech.js';

type RegisteredVoiceProviderRuntime = Parameters<VoiceProvidersRegistrationApi['register']>[1];

const clientTarget = Object.freeze({
    realm: 'client' as const,
    artifactId: 'voice-runtime-web',
    exportName: 'activate',
    platform: 'web' as const,
});
const clientRightTarget = Object.freeze({
    realm: 'client' as const,
    artifactId: clientTarget.artifactId,
    exportName: clientTarget.exportName,
    platforms: Object.freeze(['web' as const]),
});

const conversationDeclaration = VoiceProviderContributionSchema.parse({
    id: 'conversation',
    title: 'Conversation',
    kind: 'conversation',
    roles: ['realtime_conversation'],
    platforms: ['web'],
    capabilities: {
        turn: { cancelResponse: false, bargeIn: false },
    },
    client: {
        artifactId: clientRightTarget.artifactId,
        exportName: clientRightTarget.exportName,
    },
});

function speechDeclaration(input: Readonly<{
    roles: readonly ('dictation_stt' | 'conversation_stt' | 'conversation_tts')[];
    catalog?: 'models' | 'voices';
    settingsAction?: boolean;
}>): VoiceProviderContribution {
    const catalogFieldId = input.catalog ?? null;
    const fieldIds = new Set<string>();
    if (catalogFieldId) fieldIds.add(catalogFieldId);
    if (input.roles.some((role) => role === 'dictation_stt' || role === 'conversation_stt')) {
        fieldIds.add(input.catalog === 'models' ? 'models' : 'model');
    }
    if (input.roles.includes('conversation_tts')) {
        fieldIds.add(input.catalog === 'voices' ? 'voices' : 'voiceName');
        fieldIds.add('format');
    }
    if (input.settingsAction) fieldIds.add('api-url');
    return VoiceProviderContributionSchema.parse({
        id: 'speech',
        title: 'Speech',
        kind: 'speech',
        roles: input.roles,
        platforms: ['web'],
        settings: {
            schemaVersion: 2,
            fields: [...fieldIds].map((id) => id === 'format'
                ? {
                    id,
                    title: 'Format',
                    schema: { type: 'string' as const, enum: ['wav'] },
                    default: 'wav',
                    presentation: {
                        control: 'select' as const,
                        options: [{ value: 'wav', title: 'WAV' }],
                    },
                }
                : {
                    id,
                    title: id === 'api-url' ? 'API URL' : 'Selection',
                    schema: { type: 'string' as const, minLength: 1, maxLength: 512 },
                    default: id === 'api-url' ? 'https://example.test' : 'default',
                    presentation: { control: id === catalogFieldId ? 'select' as const : 'text' as const },
                }),
            ...(input.settingsAction
                ? {
                    actions: [{
                        id: 'refresh',
                        title: 'Refresh',
                        placement: { kind: 'contributionFooter' as const },
                        confirmation: { kind: 'none' as const },
                        patchFieldIds: ['api-url'],
                    }],
                }
                : {}),
        },
        ...(input.catalog
            ? { catalogs: [{ kind: input.catalog, settingFieldId: input.catalog, allowCustom: true }] }
            : {}),
    });
}

function createSpeechScope(
    declaration: VoiceProviderContribution | undefined,
) {
    return createPluginRegistrationScope({
        pluginId: 'acme.voice',
        target: { realm: 'daemon' },
        rights: [{
            family: 'voiceProviders',
            localId: 'speech',
            target: { realm: 'daemon' },
            ...(declaration ? { voiceProviderDeclaration: declaration } : {}),
        }],
    });
}

describe('plugin registration scope targets', () => {
    it('accepts registrations only for the exact client artifact entry', () => {
        const action = vi.fn(async () => ({ ok: true }));
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.voice',
            target: clientTarget,
            rights: [{ family: 'actions', localId: 'connect', target: clientRightTarget }],
        });

        if (false) {
            void scope.api.voiceProviders;
            // @ts-expect-error A client registration scope does not expose daemon registrations.
            void scope.api.hooks;
        }
        expect(scope.api.actions.register('connect', action)).toBeUndefined();
        expect(scope.commit()).toEqual([{
            family: 'actions',
            localId: 'connect',
            value: expect.any(Function),
        }]);
    });

    it.each([
        ['realm', { realm: 'daemon' as const }],
        ['artifact', { ...clientRightTarget, artifactId: 'other-artifact' }],
        ['export', { ...clientRightTarget, exportName: 'otherExport' }],
        ['platform', { ...clientRightTarget, platforms: ['ios' as const] }],
    ])('rejects a right assigned to the wrong %s before staging', (_label, target) => {
        expect(() => createPluginRegistrationScope({
            pluginId: 'acme.voice',
            target: clientTarget,
            rights: [{ family: 'actions', localId: 'connect', target }],
        })).toThrow(/realm/i);
    });

    it('stages background services through the same atomic transaction', () => {
        const runner = vi.fn(async () => {});
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.background',
            target: { realm: 'daemon' },
            rights: [{
                family: 'backgroundServices',
                localId: 'indexer',
                target: { realm: 'daemon' },
            }],
        });

        expect(scope.api.backgroundServices.register('indexer', runner)).toBeUndefined();
        expect(scope.commit()).toEqual([{
            family: 'backgroundServices',
            localId: 'indexer',
            value: runner,
        }]);
    });

    it('uses one Voice registration method for its declared contribution identity', () => {
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.voice',
            target: { realm: 'daemon' },
            rights: [{
                family: 'voiceProviders',
                localId: 'speech',
                target: { realm: 'daemon' },
                voiceProviderDeclaration: speechDeclaration({
                    roles: ['conversation_tts'],
                }),
            }],
        });
        const runtime = Object.freeze({
            kind: 'speech' as const,
            synthesize: async (request: Readonly<{
                requestId: string;
                input: string;
                model: string | null;
                voiceName: string;
                languageCode: string | null;
                format: 'mp3' | 'wav';
                speakingRate: number | null;
                pitch: number | null;
            }>) => ({
                requestId: request.requestId,
                bytes: new Uint8Array(),
                mimeType: 'audio/wav' as const,
            }),
        } satisfies RegisteredVoiceProviderRuntime);

        expect(Object.keys(scope.api.voiceProviders)).toEqual(['register']);
        expect(scope.api.voiceProviders.register('speech', runtime)).toBeUndefined();
        expect(scope.commit()).toEqual([{
            family: 'voiceProviders',
            localId: 'speech',
            value: {
                kind: 'speech',
                synthesize: expect.any(Function),
            },
        }]);

    });

    it('retains the trusted conversation runtime and protocol method receivers', () => {
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.voice',
            target: clientTarget,
            rights: [{
                family: 'voiceProviders',
                localId: 'conversation',
                target: clientRightTarget,
                voiceProviderDeclaration: conversationDeclaration,
            }],
        });
        const runtime = {
            kind: 'conversation' as const,
            protocol: {
                async prepare() { return { kind: 'unavailable' as const, reason: 'test' }; },
                decodeControl() { return []; },
                encodeTurnControl() { return null; },
                continuation: { type: 'response.create' },
                encodePostInputCommitControls(this: Readonly<{ continuation: Readonly<{ type: string }> }>) {
                    return [this.continuation];
                },
            },
            async createConnection() { return {} as never; },
            encodeToolResults() { return []; },
            encodeToolContinuation() { return {}; },
            encodeContextUpdate() { return []; },
            microphoneMode: 'host_pcm' as const,
            encodeTextTurn(this: Readonly<{ kind: 'conversation' }>, text: string) {
                return [{ kind: this.kind, text }];
            },
        } as unknown as RegisteredVoiceProviderRuntime;

        scope.api.voiceProviders.register('conversation', runtime);
        const [registration] = scope.commit();
        if (registration?.family !== 'voiceProviders'
            || registration.value.kind !== 'conversation') {
            throw new Error('Expected committed conversation registration');
        }

        expect(registration.value.encodeTextTurn('captured'))
            .toEqual([{ kind: 'conversation', text: 'captured' }]);
        expect(registration.value.microphoneMode).toBe('host_pcm');
        expect(registration.value.protocol.encodePostInputCommitControls?.())
            .toEqual([{ type: 'response.create' }]);
        if (runtime.kind === 'conversation') {
            Reflect.set(runtime.protocol, 'encodePostInputCommitControls', () => [{ type: 'replacement' }]);
        }
        expect(registration.value.protocol.encodePostInputCommitControls?.())
            .toEqual([{ type: 'replacement' }]);
    });

    it('retains a class-based Voice runtime and retains its prototype-method receiver', async () => {
        class SpeechRuntime {
            readonly kind = 'speech' as const;
            readonly prefix = 'captured';
            calls = 0;

            async synthesize(request: VoiceSpeechSynthesizeRequest) {
                this.calls += 1;
                return {
                    requestId: request.requestId,
                    bytes: new TextEncoder().encode(this.prefix),
                    mimeType: 'audio/wav' as const,
                };
            }
        }
        const scope = createSpeechScope(speechDeclaration({ roles: ['conversation_tts'] }));
        const runtime = new SpeechRuntime();
        scope.api.voiceProviders.register('speech', runtime as RegisteredVoiceProviderRuntime);

        const [registration] = scope.commit();
        if (registration?.family !== 'voiceProviders' || registration.value.kind !== 'speech') {
            throw new Error('Expected committed speech registration');
        }
        await expect(registration.value.synthesize!({
            requestId: 'class-runtime',
            input: 'hello',
            model: null,
            voiceName: 'default',
            languageCode: null,
            format: 'wav',
            speakingRate: null,
            pitch: null,
        }, {} as VoiceSpeechOperationContext)).resolves.toMatchObject({
            requestId: 'class-runtime',
            mimeType: 'audio/wav',
        });
        expect(runtime.calls).toBe(1);
    });

    it('retains live receiver-sensitive MCP methods and cleanup', async () => {
        class ReceiverSensitiveMcpRuntime implements PluginMcpServerRuntime {
            calls = 0;
            disposals = 0;

            async listTools() {
                this.calls += 1;
                return { items: [] };
            }

            async callTool() { return { content: [] }; }
            async listResources() { return { items: [] }; }
            async listResourceTemplates() { return { items: [] }; }
            async readResource() { return { contents: [] }; }
            async subscribeResource() { return { dispose() {} }; }
            async listPrompts() { return { items: [] }; }
            async getPrompt() { return { messages: [] }; }

            async dispose() {
                this.disposals += 1;
            }
        }

        const runtime = new ReceiverSensitiveMcpRuntime();
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.mcp',
            target: { realm: 'daemon' },
            rights: [{
                family: 'mcp.servers',
                localId: 'tools',
                target: { realm: 'daemon' },
            }],
        });
        scope.api.mcp.registerServer('tools', runtime);
        const replacementListTools = vi.fn(async () => ({ items: [] }));
        const replacementDispose = vi.fn(async () => undefined);
        runtime.listTools = replacementListTools;
        runtime.dispose = replacementDispose;

        const [registration] = scope.commit();
        expect(registration?.family).toBe('mcp.servers');
        if (registration?.family !== 'mcp.servers') {
            throw new Error('Expected committed MCP server registration');
        }
        expect(registration.value).toBe(runtime);
        expect(Object.isFrozen(registration.value)).toBe(false);
        await registration.value.listTools({}, {} as never);
        await scope.dispose();

        expect(runtime.calls).toBe(0);
        expect(runtime.disposals).toBe(0);
        expect(replacementListTools).toHaveBeenCalledOnce();
        expect(replacementDispose).toHaveBeenCalledOnce();
    });

    it('publishes no partial generation and cleans MCP runtime after a duplicate registration', async () => {
        const dispose = vi.fn(async () => undefined);
        const mcp = {
            async listTools() { return { items: [] }; },
            async callTool() { return { content: [] }; },
            async listResources() { return { items: [] }; },
            async listResourceTemplates() { return { items: [] }; },
            async readResource() { return { contents: [] }; },
            async subscribeResource() { return { dispose() {} }; },
            async listPrompts() { return { items: [] }; },
            async getPrompt() { return { messages: [] }; },
            dispose,
        } satisfies PluginMcpServerRuntime;
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.atomic',
            target: { realm: 'daemon' },
            rights: [
                { family: 'mcp.servers', localId: 'tools', target: { realm: 'daemon' } },
                { family: 'providers', localId: 'broken', target: { realm: 'daemon' } },
            ],
        });
        scope.api.mcp.registerServer('tools', mcp);
        const provider = { start: async () => { throw new Error('not invoked'); } } satisfies ManagedProviderRuntime;
        scope.api.providers.register('broken', provider);
        expect(() => scope.api.providers.register('broken', provider)).toThrow(/duplicate/i);
        expect(() => scope.commit()).toThrow(/failed/i);
        expect(scope.registrations()).toEqual([]);
        await scope.dispose();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('waits for MCP cleanup settlement before the next LIFO cleanup', async () => {
        vi.useFakeTimers();
        const attempts: string[] = [];
        const mcpRuntime = (dispose: PluginMcpServerRuntime['dispose']) => ({
            async listTools() { return { items: [] }; },
            async callTool() { return { content: [] }; },
            async listResources() { return { items: [] }; },
            async listResourceTemplates() { return { items: [] }; },
            async readResource() { return { contents: [] }; },
            async subscribeResource() { return { dispose() {} }; },
            async listPrompts() { return { items: [] }; },
            async getPrompt() { return { messages: [] }; },
            dispose,
        } satisfies PluginMcpServerRuntime);
        let rejectCleanup!: (error: Error) => void;
        const cleanupGate = new Promise<void>((_resolve, reject) => { rejectCleanup = reject; });
        const hung = vi.fn((): Promise<void> => {
            attempts.push('hung');
            return cleanupGate;
        });
        const older = vi.fn(async () => {
            attempts.push('older');
        });
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.bounded-disposal',
            target: { realm: 'daemon' },
            rights: [
                { family: 'mcp.servers', localId: 'older', target: { realm: 'daemon' } },
                { family: 'mcp.servers', localId: 'hung', target: { realm: 'daemon' } },
            ],
        });
        scope.api.mcp.registerServer('older', mcpRuntime(older));
        scope.api.mcp.registerServer('hung', mcpRuntime(hung));
        scope.commit();

        const disposal = scope.dispose();
        let failure: unknown = null;
        void disposal.catch((error: unknown) => { failure = error; });
        try {
            await vi.advanceTimersByTimeAsync(5_001);
            expect(failure).toBeNull();
            expect(attempts).toEqual(['hung']);
            rejectCleanup(new Error('slow MCP cleanup failed'));
            await expect(disposal).rejects.toThrow('slow MCP cleanup failed');
            expect(attempts).toEqual(['hung', 'older']);
            expect(hung).toHaveBeenCalledTimes(1);
            expect(older).toHaveBeenCalledTimes(1);
        } finally {
            rejectCleanup(new Error('slow MCP cleanup failed'));
            await disposal.catch(() => undefined);
            vi.useRealTimers();
        }
    });

    it('enters failed state before notifying a throwing activation-failure observer', () => {
        let failureCount = 0;
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.failure-observer',
            target: { realm: 'daemon' },
            rights: [{ family: 'providers', localId: 'provider', target: { realm: 'daemon' } }],
            onFailure() {
                failureCount += 1;
                if (failureCount === 1) throw new Error('observer failed');
            },
        });
        expect(() => scope.api.providers.register(
            'undeclared',
            { start: async () => { throw new Error('not invoked'); } },
        )).toThrow('observer failed');
        expect(scope.registrations()).toEqual([]);
        expect(() => scope.commit()).toThrow(/activation registration is failed/i);
    });

    it('cleans a staged MCP runtime when activation aborts before commit', async () => {
        const dispose = vi.fn(async () => undefined);
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.aborted',
            target: { realm: 'daemon' },
            rights: [{ family: 'mcp.servers', localId: 'tools', target: { realm: 'daemon' } }],
        });
        scope.api.mcp.registerServer('tools', {
            async listTools() { return { items: [] }; },
            async callTool() { return { content: [] }; },
            async listResources() { return { items: [] }; },
            async listResourceTemplates() { return { items: [] }; },
            async readResource() { return { contents: [] }; },
            async subscribeResource() { return { dispose() {} }; },
            async listPrompts() { return { items: [] }; },
            async getPrompt() { return { messages: [] }; },
            dispose,
        });

        await scope.dispose();
        expect(scope.registrations()).toEqual([]);
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('retains live SCM handler topology and receiver state', async () => {
        const detection: {
            calls: number;
            detectRepo: NonNullable<NonNullable<BackendRuntime['handlers']['detection']>['detectRepo']>;
        } = {
            calls: 0,
            detectRepo() {
                this.calls += 1;
                return { isRepo: true, rootPath: '/workspace', mode: '.git' as const };
            },
        };
        const prepareReviewWorkspace = vi.fn();
        const verifyPreparedReviewWorkspace = vi.fn();
        const resolveWorkspaceTransfer = vi.fn();
        const branch = {
            async operationSkip() { return { success: true, stdout: 'skipped' }; },
            async conflictAcceptSide() { return { success: true, stdout: 'accepted' }; },
            async conflictMarkResolved() { return { success: true, stdout: 'resolved' }; },
        } satisfies NonNullable<BackendRuntime['handlers']['branch']>;
        const runtime = {
            handlers: {
                detection,
                branch,
                workspaceIntegration: {
                    prepareReviewWorkspace,
                    verifyPreparedReviewWorkspace,
                    resolveWorkspaceTransfer,
                },
            },
        } satisfies BackendRuntime;
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.scm',
            target: { realm: 'daemon' },
            rights: [{
                family: 'scmBackends',
                localId: 'git',
                target: { realm: 'daemon' },
            }],
        });
        scope.api.scm.registerBackend('git', runtime);
        const replacement = vi.fn(() => ({
            isRepo: false,
            rootPath: null,
            mode: null,
        }));
        detection.detectRepo = replacement;

        const [registration] = scope.commit();
        if (registration?.family !== 'scmBackends') {
            throw new Error('Expected committed SCM backend registration');
        }
        expect(Object.isFrozen(registration.value)).toBe(false);
        expect(Object.isFrozen(registration.value.handlers)).toBe(false);
        expect(Object.isFrozen(registration.value.handlers.detection)).toBe(false);
        expect(Object.isFrozen(registration.value.handlers.workspaceIntegration)).toBe(false);
        const context = { cwd: '/workspace', projectKey: 'project', detection: { isRepo: true, rootPath: '/workspace', mode: '.git' as const } };
        const signal = new AbortController().signal;
        expect(await registration.value.handlers.branch?.operationSkip?.({ request: { operation: 'rebase' }, context, signal }))
            .toEqual({ success: true, stdout: 'skipped' });
        expect(await registration.value.handlers.branch?.conflictAcceptSide?.({ request: { path: 'file', side: 'ours' }, context, signal }))
            .toEqual({ success: true, stdout: 'accepted' });
        expect(await registration.value.handlers.branch?.conflictMarkResolved?.({ request: { paths: ['file'] }, context, signal }))
            .toEqual({ success: true, stdout: 'resolved' });
        expect(registration.value.handlers.workspaceIntegration?.prepareReviewWorkspace)
            .toBeTypeOf('function');
        expect(registration.value.handlers.workspaceIntegration?.verifyPreparedReviewWorkspace)
            .toBeTypeOf('function');
        // The combined transfer leaf is the atomic entries+metadata result the
        // host prefers. Dropping it here silently demotes a backend to the two
        // racing compatibility leaves.
        expect(registration.value.handlers.workspaceIntegration?.resolveWorkspaceTransfer)
            .toBeTypeOf('function');
        detection.detectRepo = vi.fn(() => ({ isRepo: true, rootPath: '/late', mode: '.git' as const }));
        expect(registration.value.handlers.detection?.detectRepo?.({ cwd: '/workspace' }))
            .toEqual({ isRepo: true, rootPath: '/late', mode: '.git' });
        expect(detection.calls).toBe(0);
        expect(replacement).not.toHaveBeenCalled();
    });

    it('retains trusted class-based SCM runtime descriptor data', () => {
        class MutableCapabilities {
            public state = 'before';
        }
        const runtime = {
            runtime: {
                repoModes: ['git'],
                capabilities: new MutableCapabilities(),
                commands: [],
            },
            handlers: {},
        } as unknown as BackendRuntime;
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.scm',
            target: { realm: 'daemon' },
            rights: [{
                family: 'scmBackends',
                localId: 'git',
                target: { realm: 'daemon' },
            }],
        });

        scope.api.scm.registerBackend('git', runtime);
        (runtime.runtime!.capabilities as unknown as MutableCapabilities).state = 'after';

        const [registration] = scope.commit();
        if (registration?.family !== 'scmBackends' || !registration.value.runtime) {
            throw new Error('Expected committed SCM backend registration');
        }

        expect(registration.value.runtime.capabilities).toEqual({ state: 'after' });
        (runtime.runtime!.capabilities as unknown as MutableCapabilities).state = 'later';
        expect(registration.value.runtime.capabilities).toEqual({ state: 'later' });
    });

    it('retains live SCM hosting capability methods and receiver state', () => {
        const routing = {
            baseUrl: 'https://captured.example',
            detectRemote() {
                return null;
            },
            buildCompareUrl() {
                return this.baseUrl;
            },
        } satisfies NonNullable<HostingProviderRuntime['adapter']['routing']> & {
            baseUrl: string;
        };
        const adapter: HostingProviderRuntime['adapter'] = {
            routing,
            pullRequests: {
                supportsDraftCreate: true,
                getPullRequestAuthProfileKey: () => 'forge',
                listPullRequests: async () => [],
                getPullRequest: async () => null,
                createPullRequest: async () => { throw new Error('not invoked'); },
            },
        };
        const runtime = { adapter } satisfies HostingProviderRuntime;
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.scm-hosting',
            target: { realm: 'daemon' },
            rights: [{
                family: 'scmHostingProviders',
                localId: 'forge',
                target: { realm: 'daemon' },
            }],
        });
        scope.api.scm.registerHostingProvider('forge', runtime);
        const replacement = vi.fn(() => 'https://replacement.example');
        routing.buildCompareUrl = replacement;

        const [registration] = scope.commit();
        if (registration?.family !== 'scmHostingProviders') {
            throw new Error('Expected committed SCM hosting registration');
        }
        expect(Object.isFrozen(registration.value)).toBe(false);
        expect(Object.isFrozen(registration.value.adapter)).toBe(false);
        expect(registration.value.adapter.pullRequests?.supportsDraftCreate).toBe(true);
        routing.buildCompareUrl = vi.fn(() => 'https://late.example');
        expect(registration.value.adapter.routing?.buildCompareUrl({} as never))
            .toBe('https://late.example');
        expect(replacement).not.toHaveBeenCalled();
    });

    it('retains a trusted class-based Composer reference runtime through its declared family', async () => {
        class ComposerRuntime {
            readonly marker = 'captured';
            readonly unrelated = true;

            async search() {
                return { marker: this.marker } as never;
            }

            async resolve() {
                return { marker: this.marker } as never;
            }
        }
        const runtime = new ComposerRuntime();
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.composer',
            target: { realm: 'daemon' },
            rights: [{
                family: 'composerReferences',
                localId: 'issues',
                target: { realm: 'daemon' },
            }],
        });
        scope.api.composerReferences.register(
            'issues',
            runtime as ComposerReferenceRuntime,
        );
        (runtime as unknown as { search: () => Promise<unknown> }).search = async () => ({
            marker: 'replacement',
        });

        const [registration] = scope.commit();
        if (registration?.family !== 'composerReferences') {
            throw new Error('Expected committed Composer registration');
        }

        (runtime as unknown as { search: () => Promise<unknown> }).search = async () => ({
            marker: 'late',
        });
        const signal = new AbortController().signal;
        await expect(registration.value.search('issue', { signal } as PluginInvocationContext))
            .resolves.toEqual({ marker: 'late' });
        expect(registration.value).toBe(runtime);
    });
});
