import { describe, expect, it } from 'vitest';

import {
    areSessionListRenderableExternalSessionIdentitiesEqual,
    buildSessionListRenderableMetadataComparison,
    normalizeSessionListRenderableMetadataComparison,
    readSessionListRenderableMetadataComparison,
} from './sessionListRenderableMetadataComparison';

const canonicalExternalSessionLink = {
    v: 1 as const,
    agentId: 'codex',
    machineId: 'machine-1',
    remoteSessionId: 'remote-1',
    source: { kind: 'codexHome' as const, home: 'user' as const },
};

describe('sessionListRenderableMetadataComparison', () => {
    it('compares normalized external-session source identity independent of object key order', () => {
        expect(areSessionListRenderableExternalSessionIdentitiesEqual(
            {
                v: 1,
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source: {
                    kind: 'opencodeServer',
                    baseUrl: 'http://127.0.0.1:4096',
                    directory: '/home/u/repo',
                },
            },
            {
                v: 1,
                agentId: 'opencode',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source: {
                    directory: '/home/u/repo',
                    baseUrl: 'http://127.0.0.1:4096',
                    kind: 'opencodeServer',
                },
            },
        )).toBe(true);
    });

    it('compares dynamic third-party external-session sources without a built-in catalog entry', () => {
        expect(areSessionListRenderableExternalSessionIdentitiesEqual(
            {
                v: 1,
                agentId: 'external-only-agent',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source: {
                    kind: 'sharedLocalKind',
                    scope: 'team:one',
                },
            },
            {
                v: 1,
                agentId: 'external-only-agent',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source: {
                    scope: 'team:one',
                    kind: 'sharedLocalKind',
                },
            },
        )).toBe(true);
    });

    it('keeps relink generation distinct for connection-scoped status demand fencing', () => {
        expect(areSessionListRenderableExternalSessionIdentitiesEqual(
            {
                ...canonicalExternalSessionLink,
                linkedAtMs: 10,
            },
            {
                ...canonicalExternalSessionLink,
                linkedAtMs: 11,
            },
        )).toBe(false);
    });

    it('normalizes protocol-valid external-session links without providerId', () => {
        const comparison = readSessionListRenderableMetadataComparison({
            path: '/home/u/repo',
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'machine-1',
                remoteSessionId: 'remote-1',
                source: { kind: 'codexHome', home: 'user' },
            },
        } as any);

        expect(comparison?.externalSessionV1).toEqual({
            v: 1,
            agentId: 'codex',
            machineId: 'machine-1',
            remoteSessionId: 'remote-1',
            source: { kind: 'codexHome', home: 'user' },
        });
        expect(comparison?.externalSessionV1).not.toHaveProperty('providerId');
    });

    it('reuses the previous comparison when the metadata is semantically identical', () => {
        const metadata = {
            name: 'Repo',
            summary: { text: 'Summary' },
            path: '/home/u/repo',
            homeDir: '/home/u',
            host: 'mbp',
            machineId: 'm1',
            flavor: 'pro',
            externalSessionV1: canonicalExternalSessionLink,
            systemSessionV1: { hidden: false },
        };

        const previous = buildSessionListRenderableMetadataComparison(metadata as any);
        const next = buildSessionListRenderableMetadataComparison(metadata as any, previous);

        expect(next).toBe(previous);
    });

    it('normalizes the renderable metadata fields used by the store predicates', () => {
        const comparison = readSessionListRenderableMetadataComparison({
            summary: { text: 'Summary' },
            path: '/home/u/repo',
            externalSessionV1: canonicalExternalSessionLink,
            systemSessionV1: { hidden: true },
        } as any);

        expect(comparison).toEqual({
            name: undefined,
            summaryText: 'Summary',
            path: '/home/u/repo',
            homeDir: null,
            host: null,
            machineId: null,
            flavor: null,
            externalSessionV1: canonicalExternalSessionLink,
            externalAgentObservationV1: null,
            readStateV1: null,
            hiddenSystemSession: true,
            terminalControlServiceabilityV1: null,
        });
    });

    it('falls back to legacy summaryText when canonical summary text is absent', () => {
        const comparison = readSessionListRenderableMetadataComparison({
            summaryText: 'Cached shell title',
            path: '/home/u/repo',
        } as any);

        expect(comparison?.summaryText).toBe('Cached shell title');
    });

    it('reuses the shared normalization helper for equivalent comparison snapshots', () => {
        const previous = normalizeSessionListRenderableMetadataComparison({
            name: 'Repo',
            summaryText: 'Summary',
            path: '/home/u/repo',
            homeDir: '/home/u',
            host: 'mbp',
            machineId: 'm1',
            flavor: 'pro',
            externalSessionV1: canonicalExternalSessionLink,
            readStateV1: null,
            terminalControlServiceabilityV1: null,
            hiddenSystemSession: false,
        });

        const next = normalizeSessionListRenderableMetadataComparison({
            name: 'Repo',
            summaryText: 'Summary',
            path: '/home/u/repo',
            homeDir: '/home/u',
            host: 'mbp',
            machineId: 'm1',
            flavor: 'pro',
            externalSessionV1: canonicalExternalSessionLink,
            readStateV1: null,
            hiddenSystemSession: false,
        }, previous);

        expect(next).toBe(previous);
    });
});
