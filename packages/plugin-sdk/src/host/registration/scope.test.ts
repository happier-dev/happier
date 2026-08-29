import { describe, expect, it, vi } from 'vitest';
import {
    VoiceProviderContributionSchema,
    type VoiceProviderContribution,
} from '@happier-dev/protocol';

import { createPluginRegistrationScope } from './index.js';
import type {
    BackendRuntime,
    ComposerReferenceRuntime,
    HostingProviderRuntime,
    PluginMcpServerRuntime,
} from '../../activation.js';
import type { PluginInvocationContext } from '../../invocation.js';
import type { PromptAssetAdapter } from '../../resources.js';
import type { ManagedProviderRuntime } from '../../managed-services/contract.js';
import type { VoiceProvidersRegistrationApi } from '../../voice/projections.js';
import type {
    SpeechProviderRuntime,
    VoiceSpeechOperationContext,
    VoiceSpeechSynthesizeRequest,
    VoiceSpeechTranscribeRequest,
} from '../../voice/speech.js';

type RegisteredVoiceProviderRuntime = Parameters<VoiceProvidersRegistrationApi['register']>[1];

const clientTarget = Object.freeze({
    realm: 'client' as const,
    artifactId: 'voice-runtime-web',
    modulePath: './voiceRuntime',
    exportName: 'activate',
    platform: 'web' as const,
});
const clientRightTarget = Object.freeze({
    realm: 'client' as const,
    artifactId: clientTarget.artifactId,
    modulePath: clientTarget.modulePath,
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
        modulePath: clientRightTarget.modulePath,
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

function speechRuntime(input: Readonly<{
    transcribe?: boolean;
    synthesize?: boolean;
    catalog?: boolean;
    settingsActions?: boolean;
}>): RegisteredVoiceProviderRuntime {
    return Object.freeze({
        kind: 'speech' as const,
        ...(input.transcribe
            ? {
                transcribe: async (request: VoiceSpeechTranscribeRequest) => ({
                    requestId: request.requestId,
                    text: '',
                }),
            }
            : {}),
        ...(input.synthesize
            ? {
                synthesize: async (request: VoiceSpeechSynthesizeRequest) => ({
                    requestId: request.requestId,
                    bytes: new Uint8Array(),
                    mimeType: 'audio/wav' as const,
                }),
            }
            : {}),
        ...(input.catalog
            ? { catalog: Object.freeze({ list: async () => Object.freeze([]) }) }
            : {}),
        ...(input.settingsActions
            ? { settingsActions: Object.freeze({ execute: async () => ({ patch: Object.freeze({}) }) }) }
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
        ['module', { ...clientRightTarget, modulePath: './otherModule' }],
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

    it('uses one Voice registration method and rejects a runtime from the wrong realm', () => {
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

        const wrongRealm = createPluginRegistrationScope({
            pluginId: 'acme.voice',
            target: { realm: 'daemon' },
            rights: [{
                family: 'voiceProviders',
                localId: 'conversation',
                target: { realm: 'daemon' },
                voiceProviderDeclaration: conversationDeclaration,
            }],
        });
        wrongRealm.api.voiceProviders.register(
            'conversation',
            Object.freeze({
                kind: 'conversation' as const,
                protocol: Object.freeze({
                    async prepare() { return { kind: 'unavailable' as const, reason: 'test' }; },
                    decodeControl() { return []; },
                    encodeTurnControl() { return null; },
                }),
                async createConnection() { return {} as never; },
                encodeToolResults() { return []; },
                encodeToolContinuation() { return {}; },
                encodeContextUpdate() { return []; },
                microphoneMode: 'host_webrtc' as const,
                encodeTextTurn() { return []; },
            }) as unknown as RegisteredVoiceProviderRuntime,
        );
        expect(() => wrongRealm.commit()).toThrow(/Voice.*realm/i);
    });

    it('captures the exact conversation topology and retains the root method receiver', () => {
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
    });

    it('rejects a provider-managed conversation runtime without an input mute setter before publication', () => {
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
            },
            async createConnection() { return {} as never; },
            encodeToolResults() { return []; },
            encodeToolContinuation() { return {}; },
            encodeContextUpdate() { return []; },
            encodeTextTurn() { return []; },
            microphoneMode: 'provider_managed' as const,
        } as unknown as RegisteredVoiceProviderRuntime;

        scope.api.voiceProviders.register('conversation', runtime);

        expect(() => scope.commit()).toThrow(/invalid 'voiceProviders\/conversation' runtime/i);
        expect(scope.registrations()).toEqual([]);
    });

    it.each([
        ['microphoneMode', 'browser_capture'],
        ['outputLevelMeter', 'estimated'],
    ] as const)(
        'rejects an invalid conversation runtime %s literal during commit snapshot',
        (field, invalidValue) => {
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
                },
                async createConnection() { return {} as never; },
                encodeToolResults() { return []; },
                encodeToolContinuation() { return {}; },
                encodeContextUpdate() { return []; },
                encodeTextTurn() { return []; },
                [field]: invalidValue,
            } as unknown as RegisteredVoiceProviderRuntime;

            scope.api.voiceProviders.register('conversation', runtime);
            expect(() => scope.commit()).toThrow(/invalid 'voiceProviders\/conversation' runtime/i);
            expect(scope.registrations()).toEqual([]);
        },
    );

    it.each(['models', 'voices'] as const)(
        'accepts exact speech role, %s catalog, and settings-action correspondence',
        (catalog) => {
            const scope = createSpeechScope(speechDeclaration({
                roles: ['dictation_stt', 'conversation_tts'],
                catalog,
                settingsAction: true,
            }));
            const runtime = speechRuntime({
                transcribe: true,
                synthesize: true,
                catalog: true,
                settingsActions: true,
            });

            expect(scope.api.voiceProviders.register('speech', runtime)).toBeUndefined();
            expect(scope.commit()).toEqual([{
                family: 'voiceProviders',
                localId: 'speech',
                value: {
                    kind: 'speech',
                    transcribe: expect.any(Function),
                    synthesize: expect.any(Function),
                    catalog: { list: expect.any(Function) },
                    settingsActions: { execute: expect.any(Function) },
                },
            }]);
        },
    );

    it.each([
        ['missing declaration metadata', undefined, speechRuntime({})],
        [
            'mismatched declaration identity',
            VoiceProviderContributionSchema.parse({
                ...speechDeclaration({ roles: ['conversation_tts'] }),
                id: 'other-speech',
            }),
            speechRuntime({ synthesize: true }),
        ],
        [
            'missing STT method',
            speechDeclaration({ roles: ['dictation_stt'] }),
            speechRuntime({}),
        ],
        [
            'extra STT method',
            speechDeclaration({ roles: ['conversation_tts'] }),
            speechRuntime({ transcribe: true, synthesize: true }),
        ],
        [
            'missing TTS method',
            speechDeclaration({ roles: ['conversation_tts'] }),
            speechRuntime({}),
        ],
        [
            'extra TTS method',
            speechDeclaration({ roles: ['dictation_stt'] }),
            speechRuntime({ transcribe: true, synthesize: true }),
        ],
        [
            'missing shared catalog method',
            speechDeclaration({ roles: ['dictation_stt'], catalog: 'models' }),
            speechRuntime({ transcribe: true }),
        ],
        [
            'extra shared catalog method',
            speechDeclaration({ roles: ['dictation_stt'] }),
            speechRuntime({ transcribe: true, catalog: true }),
        ],
        [
            'missing settings-action method',
            speechDeclaration({ roles: ['dictation_stt'], settingsAction: true }),
            speechRuntime({ transcribe: true }),
        ],
        [
            'extra settings-action method',
            speechDeclaration({ roles: ['dictation_stt'] }),
            speechRuntime({ transcribe: true, settingsActions: true }),
        ],
    ])('rejects %s before graph publication', (_label, declaration, runtime) => {
        const scope = createSpeechScope(declaration);

        scope.api.voiceProviders.register('speech', runtime);
        expect(() => scope.commit()).toThrow(/Voice/i);
        expect(scope.registrations()).toEqual([]);
    });

    it('captures the Voice runtime topology at commit without freezing author input', async () => {
        const scope = createSpeechScope(speechDeclaration({
            roles: ['dictation_stt'],
            catalog: 'models',
            settingsAction: true,
        }));
        const transcribe = vi.fn(async function (
            this: Readonly<{ kind: 'speech' }>,
            request: VoiceSpeechTranscribeRequest,
        ) {
            return {
                requestId: request.requestId,
                text: this.kind === 'speech' ? 'captured transcript' : 'wrong receiver',
            };
        });
        const listCatalog = vi.fn(async () => Object.freeze([{
            id: 'captured',
            name: 'Captured',
            metadata: Object.freeze({}),
        }]));
        const executeSettingsAction = vi.fn(async () => ({
            patch: Object.freeze({ 'api-url': 'https://captured.example' }),
        }));
        const runtime: {
            kind: 'speech';
            transcribe?: SpeechProviderRuntime['transcribe'];
            catalog?: { list: NonNullable<SpeechProviderRuntime['catalog']>['list'] };
            settingsActions?: { execute: NonNullable<RegisteredVoiceProviderRuntime['settingsActions']>['execute'] };
        } = {
            kind: 'speech',
            transcribe,
            catalog: { list: listCatalog },
            settingsActions: { execute: executeSettingsAction },
        };

        scope.api.voiceProviders.register('speech', runtime as RegisteredVoiceProviderRuntime);
        expect(Object.isFrozen(runtime)).toBe(false);
        expect(Object.isFrozen(runtime.catalog)).toBe(false);
        expect(Object.isFrozen(runtime.settingsActions)).toBe(false);

        const replacementTranscribe = vi.fn(async function (
            this: Readonly<{ kind: 'speech' }>,
            request: VoiceSpeechTranscribeRequest,
        ) {
            return {
                requestId: request.requestId,
                text: this.kind === 'speech' ? 'replacement transcript' : 'wrong receiver',
            };
        });
        const replacementCatalog = vi.fn(async () => Object.freeze([]));
        const replacementSettingsAction = vi.fn(async () => ({ patch: Object.freeze({}) }));
        runtime.transcribe = replacementTranscribe;
        runtime.catalog!.list = replacementCatalog;
        runtime.settingsActions!.execute = replacementSettingsAction;

        const [registration] = scope.commit();
        expect(registration?.family).toBe('voiceProviders');
        if (registration?.family !== 'voiceProviders' || registration.value.kind !== 'speech') {
            throw new Error('Expected committed speech registration');
        }
        const snapshot = registration.value;
        expect(snapshot).not.toBe(runtime);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.catalog)).toBe(true);
        expect(Object.isFrozen(snapshot.settingsActions)).toBe(true);

        runtime.transcribe = vi.fn(async () => ({ requestId: 'late', text: 'late' }));
        runtime.catalog!.list = vi.fn(async () => Object.freeze([]));
        runtime.settingsActions!.execute = vi.fn(async () => ({ patch: Object.freeze({}) }));

        await expect(snapshot.transcribe!({
            requestId: 'request-1',
            model: 'captured',
            language: null,
            mimeType: 'audio/wav',
            bytes: new Uint8Array(),
        }, {} as VoiceSpeechOperationContext)).resolves.toEqual({
            requestId: 'request-1',
            text: 'replacement transcript',
        });
        await expect(snapshot.catalog!.list(
            { catalog: 'models' },
            {} as VoiceSpeechOperationContext,
        )).resolves.toEqual([]);
        await expect(snapshot.settingsActions!.execute(
            { actionId: 'refresh', settings: {} },
            {} as never,
        )).resolves.toEqual({ patch: {} });

        expect(transcribe).not.toHaveBeenCalled();
        expect(listCatalog).not.toHaveBeenCalled();
        expect(executeSettingsAction).not.toHaveBeenCalled();
        expect(replacementTranscribe).toHaveBeenCalledOnce();
        expect(replacementCatalog).toHaveBeenCalledOnce();
        expect(replacementSettingsAction).toHaveBeenCalledOnce();
    });

    it('ignores undeclared Voice runtime root fields while publishing only the declared snapshot', () => {
        const scope = createSpeechScope(speechDeclaration({ roles: ['dictation_stt'] }));
        const runtime = {
            ...speechRuntime({ transcribe: true }),
            undeclared() {},
        } as unknown as RegisteredVoiceProviderRuntime;

        scope.api.voiceProviders.register('speech', runtime);
        const [registration] = scope.commit();

        expect(registration).toMatchObject({
            family: 'voiceProviders',
            localId: 'speech',
            value: { kind: 'speech', transcribe: expect.any(Function) },
        });
        if (registration?.family !== 'voiceProviders' || registration.value.kind !== 'speech') {
            throw new Error('Expected committed speech registration');
        }
        expect('undeclared' in registration.value).toBe(false);
    });

    it('ignores undeclared nested Voice catalog fields while retaining its declared callback', async () => {
        const scope = createSpeechScope(speechDeclaration({
            roles: ['dictation_stt'],
            catalog: 'models',
        }));
        const runtime = {
            ...speechRuntime({ transcribe: true }),
            catalog: {
                list: async () => Object.freeze([]),
                undeclared() {},
            },
        } as unknown as RegisteredVoiceProviderRuntime;

        scope.api.voiceProviders.register('speech', runtime);
        const [registration] = scope.commit();

        if (registration?.family !== 'voiceProviders' || registration.value.kind !== 'speech') {
            throw new Error('Expected committed speech registration');
        }
        expect(registration.value.catalog).toEqual({ list: expect.any(Function) });
        await expect(registration.value.catalog!.list(
            { catalog: 'models' },
            {} as VoiceSpeechOperationContext,
        )).resolves.toEqual([]);
    });

    it('captures a Voice root accessor once at commit', () => {
        const scope = createSpeechScope(speechDeclaration({ roles: ['conversation_tts'] }));
        let getterCalls = 0;
        const runtime = {} as Record<string, unknown>;
        Object.defineProperty(runtime, 'kind', {
            configurable: true,
            enumerable: true,
            get() {
                getterCalls += 1;
                return 'speech';
            },
        });
        runtime.synthesize = async () => ({
            requestId: 'captured',
            bytes: new Uint8Array(),
            mimeType: 'audio/wav',
        });

        expect(scope.api.voiceProviders.register(
            'speech',
            runtime as RegisteredVoiceProviderRuntime,
        )).toBeUndefined();
        expect(getterCalls).toBe(0);
        const [registration] = scope.commit();
        expect(getterCalls).toBe(1);
        expect(registration).toMatchObject({
            family: 'voiceProviders',
            localId: 'speech',
            value: { kind: 'speech', synthesize: expect.any(Function) },
        });
    });

    it('captures a nested Voice accessor once at commit', async () => {
        const scope = createSpeechScope(speechDeclaration({
            roles: ['dictation_stt'],
            catalog: 'models',
        }));
        let getterCalls = 0;
        const catalog = {} as Record<string, unknown>;
        Object.defineProperty(catalog, 'list', {
            configurable: true,
            enumerable: true,
            get() {
                getterCalls += 1;
                return async () => Object.freeze([]);
            },
        });
        const runtime = {
            ...speechRuntime({ transcribe: true }),
            catalog,
        } as RegisteredVoiceProviderRuntime;

        expect(scope.api.voiceProviders.register('speech', runtime)).toBeUndefined();
        expect(getterCalls).toBe(0);
        const [registration] = scope.commit();
        expect(getterCalls).toBe(1);
        if (registration?.family !== 'voiceProviders' || registration.value.kind !== 'speech') {
            throw new Error('Expected committed speech registration');
        }
        await expect(registration.value.catalog!.list(
            { catalog: 'models' },
            {} as VoiceSpeechOperationContext,
        )).resolves.toEqual([]);
    });

    it('ignores a symbol-keyed Voice runtime root field', () => {
        const scope = createSpeechScope(speechDeclaration({ roles: ['conversation_tts'] }));
        const runtime = {
            ...speechRuntime({ synthesize: true }),
            [Symbol('undeclared')]: true,
        } as RegisteredVoiceProviderRuntime;

        scope.api.voiceProviders.register('speech', runtime);
        expect(scope.commit()).toEqual([{
            family: 'voiceProviders',
            localId: 'speech',
            value: { kind: 'speech', synthesize: expect.any(Function) },
        }]);
    });

    it('captures a class-based Voice runtime and retains its prototype-method receiver', async () => {
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

    it.each([
        ['a sparse Voice runtime array', () => {
            const runtime = Object.assign([], speechRuntime({ synthesize: true })) as unknown as Record<string, unknown>;
            runtime[3] = 'sparse';
            return runtime;
        }],
        ['a custom Voice runtime array', () => {
            class VoiceRuntimeArray extends Array<unknown> {}
            return Object.assign(new VoiceRuntimeArray(), speechRuntime({ synthesize: true })) as unknown as Record<string, unknown>;
        }],
    ])('rejects %s before publication', (_label, createRuntime) => {
        const scope = createSpeechScope(speechDeclaration({ roles: ['conversation_tts'] }));
        scope.api.voiceProviders.register('speech', createRuntime() as RegisteredVoiceProviderRuntime);

        expect(() => scope.commit()).toThrow(/invalid 'voiceProviders\/speech' runtime/);
        expect(scope.registrations()).toEqual([]);
    });

    it('ignores an own __proto__ Voice runtime field without copying it into the host snapshot', () => {
        const scope = createSpeechScope(speechDeclaration({ roles: ['conversation_tts'] }));
        const runtime = Object.assign(Object.create(null) as Record<string, unknown>, speechRuntime({ synthesize: true }));
        Object.defineProperty(runtime, '__proto__', {
            configurable: true,
            enumerable: true,
            value: { polluted: true },
            writable: true,
        });

        scope.api.voiceProviders.register('speech', runtime as RegisteredVoiceProviderRuntime);
        const [registration] = scope.commit();
        if (registration?.family !== 'voiceProviders' || registration.value.kind !== 'speech') {
            throw new Error('Expected committed speech registration');
        }
        expect(Object.getPrototypeOf(registration.value)).toBe(Object.prototype);
        expect(Object.prototype.hasOwnProperty.call(registration.value, '__proto__')).toBe(false);
    });

    it('captures receiver-sensitive MCP methods and cleanup at commit', async () => {
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
        expect(registration.value).not.toBe(runtime);
        expect(Object.isFrozen(registration.value)).toBe(true);
        await registration.value.listTools({}, {} as never);
        await scope.dispose();

        expect(runtime.calls).toBe(0);
        expect(runtime.disposals).toBe(0);
        expect(replacementListTools).toHaveBeenCalledOnce();
        expect(replacementDispose).toHaveBeenCalledOnce();
    });

    it('publishes no partial generation and cleans captured MCP runtime when a later commit snapshot fails', async () => {
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
        scope.api.providers.register('broken', { start: null } as unknown as ManagedProviderRuntime);

        expect(() => scope.commit()).toThrow(/invalid 'providers\/broken' runtime/i);
        expect(scope.registrations()).toEqual([]);
        await scope.dispose();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('bounds each captured MCP cleanup attempt and continues after a hung disposer', async () => {
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
        const hung = vi.fn((): Promise<void> => {
            attempts.push('hung');
            return new Promise<void>(() => undefined);
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
            cleanupTimeoutMs: 20,
        });
        scope.api.mcp.registerServer('older', mcpRuntime(older));
        scope.api.mcp.registerServer('hung', mcpRuntime(hung));
        scope.commit();

        // Reverse order is attempted, the hung newest disposer cannot starve
        // the older cleanup, and the hung step is diagnosed by its identity.
        await expect(scope.dispose()).rejects.toThrow(
            /'mcp\.servers\/hung' cleanup timed out after 20ms/u,
        );
        expect(attempts).toEqual(['hung', 'older']);
        expect(hung).toHaveBeenCalledTimes(1);
        expect(older).toHaveBeenCalledTimes(1);
    });

    it('publishes no partial generation when plugin-owned capture code disposes during commit', async () => {
        let scope!: ReturnType<typeof createPluginRegistrationScope>;
        const runtime = {
            get start() {
                void scope.dispose();
                return async () => { throw new Error('not invoked'); };
            },
        } satisfies ManagedProviderRuntime;
        scope = createPluginRegistrationScope({
            pluginId: 'acme.reentrant-dispose',
            target: { realm: 'daemon' },
            rights: [{ family: 'providers', localId: 'provider', target: { realm: 'daemon' } }],
        });
        scope.api.providers.register('provider', runtime);

        expect(() => scope.commit()).toThrow(/became disposed during commit/i);
        expect(scope.registrations()).toEqual([]);
        await scope.dispose();
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
        scope.api.providers.register(
            'provider',
            { start: null } as unknown as ManagedProviderRuntime,
        );

        expect(() => scope.commit()).toThrow('observer failed');
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

    it('captures SCM handler topology while retaining its receiver state', async () => {
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
        const runtime = {
            handlers: {
                detection,
                workspaceIntegration: {
                    prepareReviewWorkspace,
                    verifyPreparedReviewWorkspace,
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
        expect(Object.isFrozen(registration.value)).toBe(true);
        expect(Object.isFrozen(registration.value.handlers)).toBe(true);
        expect(Object.isFrozen(registration.value.handlers.detection)).toBe(true);
        expect(Object.isFrozen(registration.value.handlers.workspaceIntegration)).toBe(true);
        expect(registration.value.handlers.workspaceIntegration?.prepareReviewWorkspace)
            .toBeTypeOf('function');
        expect(registration.value.handlers.workspaceIntegration?.verifyPreparedReviewWorkspace)
            .toBeTypeOf('function');
        detection.detectRepo = vi.fn(() => ({ isRepo: true, rootPath: '/late', mode: '.git' as const }));
        expect(registration.value.handlers.detection?.detectRepo?.({ cwd: '/workspace' }))
            .toEqual({ isRepo: false, rootPath: null, mode: null });
        expect(detection.calls).toBe(0);
        expect(replacement).toHaveBeenCalledOnce();
    });

    it('clones class-based SCM runtime descriptor data without retaining it', () => {
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
        expect(registration.value.runtime.capabilities).toEqual({ state: 'after' });
    });

    it('keeps cloned SCM runtime descriptor data independent of generic JSON budgets', () => {
        const createScope = () => createPluginRegistrationScope({
            pluginId: 'acme.scm',
            target: { realm: 'daemon' },
            rights: [{
                family: 'scmBackends' as const,
                localId: 'git',
                target: { realm: 'daemon' as const },
            }],
        });
        const nested = (depth: number): unknown => {
            let value: unknown = 'leaf';
            for (let index = 0; index < depth; index += 1) value = { value };
            return value;
        };
        const commitCapabilities = (capabilities: unknown) => {
            const scope = createScope();
            scope.api.scm.registerBackend('git', {
                runtime: {
                    repoModes: ['git'],
                    capabilities,
                    commands: [],
                },
                handlers: {},
            } as unknown as BackendRuntime);
            return scope.commit();
        };
        expect(() => commitCapabilities(nested(256))).not.toThrow();
        expect(() => commitCapabilities('a'.repeat(256 * 1024 + 1))).not.toThrow();
    });

    it('copies own __proto__ static-data keys without changing the host snapshot prototype', () => {
        const capabilities = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(capabilities, '__proto__', {
            configurable: true,
            enumerable: true,
            value: Object.freeze({ polluted: true }),
            writable: true,
        });
        const runtime = {
            runtime: {
                repoModes: ['git'],
                capabilities,
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
        const [registration] = scope.commit();
        if (registration?.family !== 'scmBackends' || !registration.value.runtime) {
            throw new Error('Expected committed SCM backend runtime descriptor');
        }
        const captured = registration.value.runtime.capabilities as unknown as Record<string, unknown>;
        expect(Object.getPrototypeOf(captured)).toBe(Object.prototype);
        expect(Object.prototype.hasOwnProperty.call(captured, '__proto__')).toBe(true);
        expect(captured.__proto__).toEqual({ polluted: true });
        expect((captured as { polluted?: boolean }).polluted).toBeUndefined();
        expect(Object.isFrozen(captured)).toBe(true);
    });

    it('clones static SCM arrays by indexed data without invoking unrelated methods', () => {
        const commands: unknown[] = [];
        const customMap = vi.fn(() => [{ mutable: true }]);
        Object.defineProperty(commands, 'map', {
            configurable: true,
            enumerable: true,
            value: customMap,
            writable: true,
        });
        const runtime = {
            runtime: {
                repoModes: ['git'],
                capabilities: {},
                commands,
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
        const [registration] = scope.commit();
        if (registration?.family !== 'scmBackends' || !registration.value.runtime) {
            throw new Error('Expected committed SCM backend registration');
        }

        expect(customMap).not.toHaveBeenCalled();
        expect(registration.value.runtime.commands).toEqual([]);
    });

    it('captures SCM hosting capability methods while retaining opaque receiver state', () => {
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
        const adapter: HostingProviderRuntime['adapter'] = { routing };
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
        expect(Object.isFrozen(registration.value)).toBe(true);
        expect(Object.isFrozen(registration.value.adapter)).toBe(true);
        routing.buildCompareUrl = vi.fn(() => 'https://late.example');
        expect(registration.value.adapter.routing?.buildCompareUrl({} as never))
            .toBe('https://replacement.example');
        expect(replacement).toHaveBeenCalledOnce();
    });

    it('rejects a partially declared SCM hosting capability group', () => {
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.scm-hosting',
            target: { realm: 'daemon' },
            rights: [{
                family: 'scmHostingProviders',
                localId: 'forge',
                target: { realm: 'daemon' },
            }],
        });

        scope.api.scm.registerHostingProvider('forge', {
            adapter: {
                routing: {
                    detectRemote: () => null,
                },
            },
        } as unknown as HostingProviderRuntime);
        expect(() => scope.commit()).toThrow(/invalid 'scmHostingProviders\/forge' runtime/i);
    });

    it('captures Prompt Asset descriptor and operations without freezing author input', async () => {
        const adapterDescriptor = {
            id: 'acme.skill',
            providerId: 'acme',
            title: 'Acme skills',
            description: 'Acme SKILL.md bundles.',
            libraryKind: 'bundle' as const,
            supportsScope: { user: true, project: true },
            supportsFiles: true,
            formatId: 'skill_md_v1',
            defaultRoots: [],
            capabilities: {},
        };
        const discover = vi.fn(async () => []);
        const adapter = {
            descriptor: adapterDescriptor,
            discover,
            async read() { throw new Error('not invoked'); },
            async writeDoc() { throw new Error('not invoked'); },
            async writeBundle() { throw new Error('not invoked'); },
            async delete() { throw new Error('not invoked'); },
        } satisfies PromptAssetAdapter;
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.prompts',
            target: { realm: 'daemon' },
            rights: [{
                family: 'promptAssets',
                localId: 'skills',
                target: { realm: 'daemon' },
                promptAssetDescriptor: adapterDescriptor,
            }],
        });
        scope.api.resources.registerPromptAssetAdapter('skills', adapter);
        const replacement = vi.fn(async () => []);

        const [registration] = scope.commit();
        if (registration?.family !== 'promptAssets') {
            throw new Error('Expected committed Prompt Asset registration');
        }
        adapter.discover = replacement;
        adapterDescriptor.title = 'Mutated title';
        adapterDescriptor.supportsScope.user = false;
        expect(Object.isFrozen(adapter)).toBe(false);
        expect(Object.isFrozen(adapterDescriptor)).toBe(false);
        expect(Object.isFrozen(registration.value)).toBe(true);
        expect(Object.isFrozen(registration.value.descriptor)).toBe(true);
        expect(registration.value.descriptor.title).toBe('Acme skills');
        expect(registration.value.descriptor.supportsScope.user).toBe(true);
        await registration.value.discover({ assetTypeId: 'acme.skill', scope: 'user' });
        expect(discover).toHaveBeenCalledOnce();
        expect(replacement).not.toHaveBeenCalled();
    });

    it('captures a class-based Prompt Asset adapter and binds its prototype methods', async () => {
        const adapterDescriptor = {
            id: 'acme.class-skill',
            providerId: 'acme',
            title: 'Class skills',
            description: 'Class-based adapter.',
            libraryKind: 'bundle' as const,
            supportsScope: { user: true, project: false },
            supportsFiles: false,
            formatId: 'skill_md_v1',
            defaultRoots: [],
            capabilities: {},
        };
        class Adapter {
            readonly descriptor = adapterDescriptor;
            readonly marker = 'captured';
            readonly unrelated = true;

            async discover() { return [{ marker: this.marker }] as never; }
            async read() { return { marker: this.marker } as never; }
            async writeDoc() { return { marker: this.marker } as never; }
            async writeBundle() { return { marker: this.marker } as never; }
            async delete() { return { marker: this.marker } as never; }
        }
        const scope = createPluginRegistrationScope({
            pluginId: 'acme.class-prompts',
            target: { realm: 'daemon' },
            rights: [{
                family: 'promptAssets',
                localId: 'skills',
                target: { realm: 'daemon' },
                promptAssetDescriptor: adapterDescriptor,
            }],
        });
        const adapter = new Adapter();
        scope.api.resources.registerPromptAssetAdapter('skills', adapter as PromptAssetAdapter);

        const [registration] = scope.commit();
        if (registration?.family !== 'promptAssets') {
            throw new Error('Expected committed Prompt Asset registration');
        }

        await expect(registration.value.discover({
            assetTypeId: 'acme.class-skill',
            scope: 'user',
        })).resolves.toEqual([{ marker: 'captured' }]);
        expect(registration.value).not.toHaveProperty('unrelated');
    });

    it('captures a class-based Composer reference runtime through the final family while ignoring unrelated fields', async () => {
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
            .resolves.toEqual({ marker: 'replacement' });
        expect(registration.value).not.toHaveProperty('unrelated');
    });
});
