import { describe, expect, it } from 'vitest';
import type { Metadata } from '@happier-dev/session-core/state';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession, deriveSessionListRenderableHasUnreadMessagesFromMetadataPatch } from './sessionListRenderable';

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
    it('retains external unread inputs through compact metadata reconciliation', () => {
        const metadata = { path: '/repo', externalSessionV1: canonicalExternalSessionLink,
            externalSessionAttentionV1: { v: 1 as const, observedProgressToken: '20:msg-2',
                viewedProgressToken: '10:msg-1', observedAtMs: 20, viewedAtMs: 10 } };
        const unread = buildSessionListRenderableMetadataComparison(metadata);
        const isUnread = (projection: typeof unread) => deriveSessionListRenderableHasUnreadMessagesFromMetadataPatch({
            metadata: projection, nextSessionSeq: 9, nextLastViewedSessionSeq: 9,
            nextLatestReadyEventSeq: 9, recomputeUnread: true,
        });
        expect(isUnread(unread)).toBe(true);
        expect(buildSessionListRenderableMetadataComparison(metadata, unread)).toBe(unread);
        const read = buildSessionListRenderableMetadataComparison({ ...metadata,
            externalSessionAttentionV1: { ...metadata.externalSessionAttentionV1,
                viewedProgressToken: '20:msg-2', viewedAtMs: 20 } }, unread);
        expect(isUnread(read)).toBe(false);
        expect(read).not.toBe(unread);
    });

    it('carries last observed branch with unavailable distinct from detached, reusing unrelated rows', () => {
        const metadata = { path: '/checkout', host: 'host', branch: 'feature/actual' };
        const first = buildSessionListRenderableMetadataComparison(metadata);
        expect(first).toHaveProperty('branch', 'feature/actual');
        expect(buildSessionListRenderableMetadataComparison({ ...metadata, version: 'changed' }, first)).toBe(first);
        const detached = buildSessionListRenderableMetadataComparison({ ...metadata, branch: null }, first);
        expect(detached).not.toBe(first);
        expect(detached).toHaveProperty('branch', null);
        const unknown = buildSessionListRenderableMetadataComparison({ path: '/checkout', host: 'host' }, detached);
        expect(unknown).not.toBe(detached);
        expect(unknown).not.toHaveProperty('branch');
    });
    it('does not promote untyped metadata fields into Project and checkout membership', () => {
        const row = buildSessionListRenderableFromSession(createSessionFixture({
            metadata: { path: '/repo', host: 'host', projectId: { id: 'anchor' }, workspaceId: 42 },
        }));
        expect(row.metadata?.path).toBe('/repo');
        expect(row.metadata?.projectId).toBeUndefined();
        expect(row.metadata?.workspaceId).toBeUndefined();

        const assigned = buildSessionListRenderableFromSession(createSessionFixture({
            metadata: { path: '/repo', host: 'host', projectId: 'anchor', workspaceId: 'checkout' },
        }), row);
        const cleared = buildSessionListRenderableFromSession(createSessionFixture({
            metadata: { path: '/repo', host: 'host', projectId: null, workspaceId: null },
        }), assigned);
        expect(cleared.metadata).toMatchObject({ projectId: null, workspaceId: null });
    });

    it('preserves Project and checkout membership and invalidates only a changed association', () => {
        const metadata: Metadata = { path: '/repo', host: 'host', projectId: 'anchor', workspaceId: 'checkout-a' };
        const first = buildSessionListRenderableMetadataComparison(metadata);
        expect(first).toMatchObject({ projectId: 'anchor', workspaceId: 'checkout-a' });
        expect(buildSessionListRenderableMetadataComparison(metadata, first)).toBe(first);
        const moved = buildSessionListRenderableMetadataComparison({ ...metadata, projectId: 'other' }, first);
        expect(moved).not.toBe(first);
        expect(moved).toMatchObject({ projectId: 'other', workspaceId: 'checkout-a' });
    });
    it('does not erase a malformed legacy Bot marker into an ordinary lean Session', () => {
        // Negative stored-metadata boundary vectors can predate today's typed schema.
        for (const bot of [{ kind: 'ordinary' }, null]) {
            expect(readSessionListRenderableMetadataComparison({ path: '/repo', bot } as unknown as Metadata)).toBeNull();
        }
    });
    it('updates lean list identity on Bot promotion/demotion while reusing unchanged marker projections', () => {
        const snapshot = { name: undefined, summaryText: null, path: '/repo', homeDir: null, host: null,
            machineId: null, flavor: null, externalSessionV1: null, readStateV1: null, hiddenSystemSession: false };
        const ordinary = normalizeSessionListRenderableMetadataComparison(snapshot);
        const promoted = normalizeSessionListRenderableMetadataComparison({ ...snapshot, bot: { kind: 'bot' } }, ordinary);
        expect(promoted.bot).toEqual({ kind: 'bot' });
        expect(promoted).not.toBe(ordinary);
        expect(normalizeSessionListRenderableMetadataComparison({ ...snapshot, bot: { kind: 'bot' } }, promoted))
            .toBe(promoted);
        const demoted = normalizeSessionListRenderableMetadataComparison(snapshot, promoted);
        expect(demoted.bot).toBeUndefined();
        expect(demoted).not.toBe(promoted);
    });
    it('publishes a changed face once and retains its identity across unrelated row refreshes', () => {
        const metadata = { path: '/repo', host: 'host', bot: { kind: 'bot' as const }, botFace: { seed: 'first' } };
        const first = buildSessionListRenderableMetadataComparison(metadata);
        if (!first) throw new Error('Expected an admitted Bot metadata projection');
        expect(first.botFace).toEqual(metadata.botFace);
        for (let i = 0; i < 100; i++) {
            expect(buildSessionListRenderableMetadataComparison({ ...metadata, unrelatedClock: i }, first)).toBe(first);
        }
        const changed = buildSessionListRenderableMetadataComparison({ ...metadata, botFace: { seed: 'picked' } }, first);
        if (!changed) throw new Error('Expected the changed Bot face projection');
        expect(changed).not.toBe(first);
        expect(changed.botFace).toEqual({ seed: 'picked' });
        expect(changed.bot).toBe(first.bot);
        expect(buildSessionListRenderableMetadataComparison({ ...metadata, name: 'Named' }, first)?.botFace).toBe(first.botFace);
    });
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
            sessionWorkspaceLocationV1: null,
            sessionDirectoryV1: null,
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
