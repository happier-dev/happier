import { describe, expect, it } from 'vitest';

import { getModelOverrideForSpawn } from './modelOverride';
import type { Session } from '../state/storageTypes';
import { SessionModelSelectionIntentV1Schema } from '@happier-dev/protocol';

function buildSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 's1',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
            path: '/repo',
            host: 'localhost',
            flavor: 'codex',
            codexSessionId: 'codex-session-1',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        modelMode: 'o3',
        modelModeUpdatedAt: 11,
        ...overrides,
    };
}

describe('getModelOverrideForSpawn', () => {
    it('returns the persisted selection when local modelModeUpdatedAt is missing', () => {
        expect(
            getModelOverrideForSpawn(
                buildSession({
                    modelModeUpdatedAt: undefined,
                    metadata: {
                        path: '/repo',
                        host: 'localhost',
                        modelOverrideV1: { v: 1, updatedAt: 1, modelId: 'o4-mini' },
                    },
                }),
                'backend:codex',
            ),
        ).toEqual({
            modelSelection: {
                v: 1,
                updatedAt: 1,
                ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'o4-mini' },
            },
        });
    });

    it('ignores a non-finite local timestamp in favor of persisted metadata', () => {
        expect(
            getModelOverrideForSpawn(
                buildSession({
                    modelMode: 'local-model',
                    modelModeUpdatedAt: Number.NaN,
                    metadata: {
                        path: '/repo',
                        host: 'localhost',
                        modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'persisted-model' },
                    },
                }),
                'backend:codex',
            ),
        ).toEqual({
            modelSelection: {
                v: 1,
                updatedAt: 10,
                ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'persisted-model' },
            },
        });
    });

    it('returns the persisted selection when local state is not newer than metadata', () => {
        expect(
            getModelOverrideForSpawn(
                buildSession({
                    modelModeUpdatedAt: 10,
                    metadata: {
                        path: '/repo',
                        host: 'localhost',
                        modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'o4-mini' },
                    },
                }),
                'backend:codex',
            ),
        ).toEqual({
            modelSelection: {
                v: 1,
                updatedAt: 10,
                ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'o4-mini' },
            },
        });
    });

    it('returns null when local mode is default (do not pass --model default)', () => {
        expect(
            getModelOverrideForSpawn(
                buildSession({
                    modelMode: 'default',
                    modelModeUpdatedAt: 11,
                    metadata: {
                        path: '/repo',
                        host: 'localhost',
                        modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'o4-mini' },
                    },
                }),
                'backend:codex',
            ),
        ).toBeNull();
    });

    it('returns an override when local state is newer than metadata', () => {
        expect(
            getModelOverrideForSpawn(
                buildSession({
                    modelMode: 'o3',
                    modelModeUpdatedAt: 11,
                    metadata: {
                        path: '/repo',
                        host: 'localhost',
                        modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'o4-mini' },
                    },
                }),
                'backend:codex',
            ),
        ).toEqual({
            modelSelection: {
                v: 1,
                updatedAt: 11,
                ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'o3' },
            },
        });
    });

    it('returns override when metadata override is missing', () => {
        expect(
            getModelOverrideForSpawn(
                buildSession({
                    modelMode: 'o3',
                    modelModeUpdatedAt: 11,
                    metadata: { path: '/repo', host: 'localhost' },
                }),
                'backend:codex',
            ),
        ).toEqual({
            modelSelection: {
                v: 1,
                updatedAt: 11,
                ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'o3' },
            },
        });
    });

    it('returns null when local model mode is blank after trim', () => {
        expect(
            getModelOverrideForSpawn(
                buildSession({
                    modelMode: '   ' as Session['modelMode'],
                    modelModeUpdatedAt: 11,
                    metadata: {
                        path: '/repo',
                        host: 'localhost',
                        modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'o4-mini' },
                    },
                }),
                'backend:codex',
            ),
        ).toBeNull();
    });

    it('returns a provider-bound canonical metadata selection without losing connection identity', () => {
        expect(getModelOverrideForSpawn(buildSession({
            modelModeUpdatedAt: 10,
            metadata: {
                path: '/repo',
                host: 'localhost',
                modelSelectionIntentV1: SessionModelSelectionIntentV1Schema.parse({
                    v: 1,
                    updatedAt: 12,
                    selection: {
                        agentTargetKey: 'backend:codex',
                        providerConnectionId: 'pc_work',
                        modelId: 'openai/gpt-5.5',
                    },
                }),
            },
        }), 'backend:codex')).toEqual({
            modelSelection: {
                v: 1,
                updatedAt: 12,
                ref: {
                    agentTargetKey: 'backend:codex',
                    providerConnectionId: 'pc_work',
                    modelId: 'openai/gpt-5.5',
                },
            },
        });
    });

    it('does not reinterpret a newer same-id presentation value as a native selection', () => {
        expect(getModelOverrideForSpawn(buildSession({
            modelMode: 'shared-id',
            modelModeUpdatedAt: 30,
            metadata: {
                path: '/repo',
                host: 'localhost',
                modelSelectionIntentV1: SessionModelSelectionIntentV1Schema.parse({
                    v: 1,
                    updatedAt: 20,
                    selection: {
                        agentTargetKey: 'backend:codex',
                        providerConnectionId: 'pc_01J00000000000000000000000',
                        modelId: 'shared-id',
                    },
                }),
            },
        }), 'backend:codex')).toEqual({
            modelSelection: {
                v: 1,
                updatedAt: 20,
                ref: {
                    agentTargetKey: 'backend:codex',
                    providerConnectionId: 'pc_01J00000000000000000000000',
                    modelId: 'shared-id',
                },
            },
        });
    });

    it('does not let a newer different-id presentation value downgrade a Provider-bound selection', () => {
        expect(getModelOverrideForSpawn(buildSession({
            modelMode: 'native-presentation-model',
            modelModeUpdatedAt: 30,
            metadata: {
                path: '/repo',
                host: 'localhost',
                modelSelectionIntentV1: SessionModelSelectionIntentV1Schema.parse({
                    v: 1,
                    updatedAt: 20,
                    selection: {
                        agentTargetKey: 'backend:codex',
                        providerConnectionId: 'pc_01J00000000000000000000000',
                        modelId: 'provider-model',
                    },
                }),
            },
        }), 'backend:codex')).toEqual({
            modelSelection: {
                v: 1,
                updatedAt: 20,
                ref: {
                    agentTargetKey: 'backend:codex',
                    providerConnectionId: 'pc_01J00000000000000000000000',
                    modelId: 'provider-model',
                },
            },
        });
    });

    it('does not let a newer local default erase a Provider-bound selection', () => {
        expect(getModelOverrideForSpawn(buildSession({
            modelMode: 'default',
            modelModeUpdatedAt: 30,
            metadata: {
                path: '/repo',
                host: 'localhost',
                modelSelectionIntentV1: SessionModelSelectionIntentV1Schema.parse({
                    v: 1,
                    updatedAt: 20,
                    selection: {
                        agentTargetKey: 'backend:codex',
                        providerConnectionId: 'pc_01J00000000000000000000000',
                        modelId: 'provider-model',
                    },
                }),
            },
        }), 'backend:codex')).toEqual({
            modelSelection: {
                v: 1,
                updatedAt: 20,
                ref: {
                    agentTargetKey: 'backend:codex',
                    providerConnectionId: 'pc_01J00000000000000000000000',
                    modelId: 'provider-model',
                },
            },
        });
    });

    it('keeps timestamp arbitration for a newer local presentation over native canonical metadata', () => {
        expect(getModelOverrideForSpawn(buildSession({
            modelMode: 'newer-native-model',
            modelModeUpdatedAt: 30,
            metadata: {
                path: '/repo',
                host: 'localhost',
                modelSelectionIntentV1: SessionModelSelectionIntentV1Schema.parse({
                    v: 1,
                    updatedAt: 20,
                    selection: {
                        agentTargetKey: 'backend:codex',
                        providerConnectionId: null,
                        modelId: 'older-native-model',
                    },
                }),
            },
        }), 'backend:codex')).toEqual({
            modelSelection: {
                v: 1,
                updatedAt: 30,
                ref: {
                    agentTargetKey: 'backend:codex',
                    providerConnectionId: null,
                    modelId: 'newer-native-model',
                },
            },
        });
    });
});
