import { afterEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';

const initialStorageState = storage.getState();

describe('outgoing user message projection', () => {
    it('uses the admitted permission mode after caller overrides, without changing unrestricted messages', async () => {
        const { buildOutgoingUserTextRecord } = await import('./outgoingUserMessage');
        const send = (permissionMode: 'yolo' | 'safe-yolo', allowedPermissionModes: readonly ('default' | 'safe-yolo')[] | null) => buildOutgoingUserTextRecord({
            text: 'hello', agentId: 'codex', permissionMode, settings: {}, session: null,
            allowedPermissionModes, metaOverrides: { permissionMode: 'yolo' },
        });
        expect(send('yolo', ['default', 'safe-yolo']).meta?.permissionMode).toBe('default');
        expect(send('safe-yolo', ['default', 'safe-yolo']).meta?.permissionMode).toBe('default');
        expect(send('yolo', null).meta?.permissionMode).toBe('yolo');
        expect(buildOutgoingUserTextRecord({ text: 'hello', agentId: 'codex', permissionMode: 'safe-yolo', settings: {},
            session: null, allowedPermissionModes: ['default', 'safe-yolo'] }).meta?.permissionMode).toBe('safe-yolo');
    });
    it('carries bounded model intent using shared Agent identity without exposing a full owner view', async () => {
        const { buildOutgoingUserTextRecord } = await import('./outgoingUserMessage');
        const selection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'sealed-model' };
        const raw = buildOutgoingUserTextRecord({ text: 'hello', agentId: 'codex', permissionMode: 'default', settings: {},
            session: { metadataLayoutVersion: 1, metadata: { v: 1, agentPresentation: { agentId: 'codex' } },
                ownerMetadataView: null, composerOptionsInput: { modelSelectionIntentV1: { v: 1, updatedAt: 20, selection } } } });
        expect(raw.meta).toEqual(expect.objectContaining({
            model: 'sealed-model', modelSelectionV1: { v: 1, updatedAt: 20, ref: selection },
        }));
    });
    afterEach(() => {
        storage.setState(initialStorageState, true);
        vi.restoreAllMocks();
    });

    it('runs a model-restricted message on the first allowed model when the Session is on Automatic or a refused model', async () => {
        const { buildOutgoingUserTextRecord } = await import('./outgoingUserMessage');
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const m1 = { agentTargetKey, providerConnectionId: null, modelId: 'model-one' };
        const m2 = { agentTargetKey, providerConnectionId: null, modelId: 'model-two' };
        const refused = { agentTargetKey, providerConnectionId: null, modelId: 'model-refused' };
        const sessionOn = (selection: typeof m1 | null) => ({
            metadataLayoutVersion: 1,
            metadata: { v: 1, agentPresentation: { agentId: 'codex' } },
            ownerMetadataView: null,
            composerOptionsInput: selection ? { modelSelectionIntentV1: { v: 1, updatedAt: 20, selection } } : {},
        });
        const foreign = { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'claude-model' };
        const send = (selection: typeof m1 | null) => buildOutgoingUserTextRecord({
            text: 'hello', agentId: 'codex', permissionMode: 'default', settings: {},
            session: sessionOn(selection), allowedModels: [foreign, m1, m2],
        });

        expect(send(null).meta).toEqual(expect.objectContaining({ modelSelectionV1: expect.objectContaining({ ref: m1 }) }));
        expect(send(refused).meta).toEqual(expect.objectContaining({ modelSelectionV1: expect.objectContaining({ ref: m1 }) }));
        expect(send(m2).meta).toEqual(expect.objectContaining({ modelSelectionV1: { v: 1, updatedAt: 20, ref: m2 } }));
        expect(buildOutgoingUserTextRecord({ text: 'hello', agentId: 'codex', permissionMode: 'default', settings: {},
            session: null, allowedModels: [foreign, m1] }).meta).toMatchObject({ modelSelectionV1: { ref: m1 } });
        // Unrestricted: the Session's own choice, Automatic included, is untouched.
        expect(buildOutgoingUserTextRecord({ text: 'hello', agentId: 'codex', permissionMode: 'default', settings: {},
            session: sessionOn(null), allowedModels: null }).meta).not.toHaveProperty('modelSelectionV1');
    });

    it('projects a local outbound pending user message before the session row is hydrated', async () => {
        vi.setSystemTime(new Date('2026-06-26T08:00:00.000Z'));
        const {
            buildOutgoingUserTextRecord,
            clearLocalOutboundUserMessage,
            projectLocalOutboundUserMessage,
        } = await import('./outgoingUserMessage');

        const rawRecord = buildOutgoingUserTextRecord({
            text: 'start the first turn',
            displayText: 'start the first turn',
            agentId: 'codex',
            modelMode: 'default',
            permissionMode: 'default',
            settings: {},
            session: null,
        });

        expect(rawRecord.meta).toEqual(expect.objectContaining({
            happierProvenanceV1: { v: 1, kind: 'host', producer: 'happierApp' },
            happierInputRequestV1: {
                v: 1,
                producer: 'happierApp',
                caller: { kind: 'host' },
                permission: {},
            },
        }));

        projectLocalOutboundUserMessage({
            sessionId: 'session-created-before-hydration',
            localId: 'local-first-turn',
            text: 'start the first turn',
            displayText: 'start the first turn',
            rawRecord,
            deliveryStatus: 'queued',
        });

        expect(storage.getState().sessionPending['session-created-before-hydration']?.messages).toMatchObject([
            {
                id: 'local-first-turn',
                localId: 'local-first-turn',
                source: 'local_outbound',
                deliveryStatus: 'queued',
                text: 'start the first turn',
                displayText: 'start the first turn',
                rawRecord,
            },
        ]);
        expect(storage.getState().sessions['session-created-before-hydration']).toBeUndefined();

        clearLocalOutboundUserMessage({
            sessionId: 'session-created-before-hydration',
            localId: 'local-first-turn',
        });

        expect(storage.getState().sessionPending['session-created-before-hydration']?.messages ?? []).toEqual([]);
    });

    it('carries a provider model literally named default without leaking it to released native-only readers', async () => {
        const { buildOutgoingUserTextRecord } = await import('./outgoingUserMessage');

        const rawRecord = buildOutgoingUserTextRecord({
            text: 'continue',
            agentId: 'opencode',
            modelMode: 'default',
            permissionMode: 'default',
            settings: {},
            metaOverrides: { model: 'must-not-leak-to-released-reader' },
            session: {
                id: 'session-provider-default',
                modelMode: 'default',
                modelModeUpdatedAt: 10,
                metadata: {
                    flavor: 'opencode',
                    modelSelectionIntentV1: {
                        v: 1,
                        updatedAt: 20,
                        selection: {
                            agentTargetKey: 'agent:happier.agent.opencode/opencode',
                            providerConnectionId: 'pc_openrouter',
                            modelId: 'default',
                        },
                    },
                },
            },
        });

        expect(rawRecord.meta).toEqual(expect.objectContaining({
            modelSelectionV1: {
                v: 1,
                updatedAt: 20,
                ref: {
                    agentTargetKey: 'agent:happier.agent.opencode/opencode',
                    providerConnectionId: 'pc_openrouter',
                    modelId: 'default',
                },
            },
        }));
        expect(rawRecord.meta).not.toHaveProperty('model');
    });

    it('dual-writes a native selection for current and released readers', async () => {
        const { buildOutgoingUserTextRecord } = await import('./outgoingUserMessage');

        const rawRecord = buildOutgoingUserTextRecord({
            text: 'continue',
            agentId: 'codex',
            modelMode: 'gpt-5.5',
            permissionMode: 'default',
            settings: {},
            session: {
                id: 'session-native-model',
                modelMode: 'gpt-5.5',
                modelModeUpdatedAt: 20,
                metadata: {
                    flavor: 'codex',
                    modelSelectionIntentV1: {
                        v: 1,
                        updatedAt: 20,
                        selection: {
                            agentTargetKey: 'agent:happier.agent.codex/codex',
                            providerConnectionId: null,
                            modelId: 'gpt-5.5',
                        },
                    },
                },
            },
        });

        expect(rawRecord.meta).toEqual(expect.objectContaining({
            model: 'gpt-5.5',
            modelSelectionV1: {
                v: 1,
                updatedAt: 20,
                ref: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    providerConnectionId: null,
                    modelId: 'gpt-5.5',
                },
            },
        }));
    });

    it('stamps Voice admission after stripping caller-controlled protected metadata', async () => {
        const { buildOutgoingUserTextRecord } = await import('./outgoingUserMessage');

        const rawRecord = buildOutgoingUserTextRecord({
            text: 'send this to the coding session',
            agentId: null,
            permissionMode: 'default',
            settings: {},
            session: null,
            metaOverrides: {
                happierProvenanceV1: { v: 1, kind: 'cli' },
                happierInputRequestV1: {
                    v: 1,
                    producer: 'cli',
                    caller: { kind: 'host' },
                    permission: {},
                },
                happierInputAuthorityV1: {
                    v: 1,
                    producer: 'cli',
                    caller: { kind: 'host' },
                    permission: {
                        admittedPermissionCeiling: 'read',
                    },
                },
            },
            hostAdmissionOrigin: 'voice',
        });

        expect(rawRecord.meta).toEqual(expect.objectContaining({
            happierProvenanceV1: { v: 1, kind: 'voice' },
            happierInputRequestV1: {
                v: 1,
                producer: 'voiceInput',
                caller: { kind: 'host' },
                permission: {},
            },
        }));
        expect(rawRecord.meta).not.toHaveProperty('happierInputAuthorityV1');
    });
});
