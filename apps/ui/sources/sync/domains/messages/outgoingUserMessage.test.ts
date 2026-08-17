import { afterEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';

const initialStorageState = storage.getState();

describe('outgoing user message projection', () => {
    afterEach(() => {
        storage.setState(initialStorageState, true);
        vi.restoreAllMocks();
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
                            agentTargetKey: 'backend:opencode',
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
                    agentTargetKey: 'backend:opencode',
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
                            agentTargetKey: 'backend:codex',
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
                    agentTargetKey: 'backend:codex',
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
