import { describe, expect, it } from 'vitest';

import { getModelOverrideForSpawn } from './modelOverride';
import type { Session } from './storageTypes';

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
    it('returns null when local modelModeUpdatedAt is missing', () => {
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
            ),
        ).toBeNull();
    });

    it('returns null when local modelModeUpdatedAt is not newer than metadata', () => {
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
            ),
        ).toBeNull();
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
            ),
        ).toEqual({
            modelId: 'o3',
            modelUpdatedAt: 11,
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
            ),
        ).toEqual({
            modelId: 'o3',
            modelUpdatedAt: 11,
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
            ),
        ).toBeNull();
    });
});
