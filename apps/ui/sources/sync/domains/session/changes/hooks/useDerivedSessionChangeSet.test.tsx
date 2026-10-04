import { createSessionFixture, createToolCallMessageFixture, renderHook } from '@/dev/testkit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const message = createToolCallMessageFixture({
    id: 'tool-call-1',
    createdAt: 10,
    tool: {
        name: 'Diff',
        state: 'completed',
        input: {
            files: [
                {
                    file_path: 'src/app.ts',
                    oldText: 'a\n',
                    newText: 'b\n',
                    unified_diff: 'diff --git a/src/app.ts b/src/app.ts\n',
                },
            ],
            _happier: {
                v: 2,
                protocol: 'codex',
                provider: 'codex',
                rawToolName: 'CodexDiff',
                canonicalToolName: 'Diff',
                sessionChangeScope: 'turn',
                turnId: 'turn_1',
                sessionId: 'session_1',
                source: 'provider_native',
                confidence: 'exact',
                turnStatus: 'completed',
                seqRange: {
                    startSeqInclusive: 1,
                    endSeqInclusive: 4,
                },
            },
        },
        createdAt: 10,
        startedAt: 10,
        completedAt: 11,
        description: null,
        result: { status: 'completed' },
    },
});

function createTurnEvidenceMessage(params: Readonly<{
    id: string;
    createdAt: number;
    source: string;
    confidence: string;
    unifiedDiff: string;
    turnId?: string;
    oldText?: string;
    newText?: string;
    filePath?: string;
}>) {
    return createToolCallMessageFixture({
        id: params.id,
        createdAt: params.createdAt,
        tool: {
            name: 'Diff',
            state: 'completed',
            input: {
                files: [
                    {
                        file_path: params.filePath ?? 'src/app.ts',
                        change_kind: 'modified',
                        source: params.source,
                        confidence: params.confidence,
                        provider: 'codex',
                        unified_diff: params.unifiedDiff,
                        oldText: params.oldText,
                        newText: params.newText,
                    },
                ],
                _happier: {
                    v: 2,
                    protocol: 'codex',
                    provider: 'codex',
                    rawToolName: 'CodexDiff',
                    canonicalToolName: 'Diff',
                    sessionChangeScope: 'turn',
                    turnId: params.turnId ?? 'turn_1',
                    sessionId: 'session_1',
                    source: params.source,
                    confidence: params.confidence,
                    turnStatus: 'completed',
                    seqRange: {
                        startSeqInclusive: 1,
                        endSeqInclusive: 4,
                    },
                },
            },
            createdAt: params.createdAt,
            startedAt: params.createdAt,
            completedAt: params.createdAt + 1,
            description: null,
            result: { status: 'completed' },
        },
    });
}

const canonicalPatchEvidence = createTurnEvidenceMessage({
    id: 'tool-call-canonical',
    createdAt: 10,
    source: 'canonical_patch_tool',
    confidence: 'exact',
    unifiedDiff: 'diff --git a/src/app.ts b/src/app.ts\n@@ canonical @@\n',
});

const laterProviderEvidence = createTurnEvidenceMessage({
    id: 'tool-call-provider',
    createdAt: 20,
    source: 'provider_native',
    confidence: 'best_effort',
    unifiedDiff: 'diff --git a/src/app.ts b/src/app.ts\n@@ provider @@\n',
});

let transcriptMessages: unknown[] = [message];
let session = createSessionFixture({ id: 'session_1', serverId: 'home-b' });

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSession: () => session,
        useSessionMessages: () => ({
            messages: transcriptMessages,
        }),
    });
});

describe('useDerivedSessionChangeSet', () => {
    beforeEach(() => {
        transcriptMessages = [message];
        session = createSessionFixture({ id: 'session_1', serverId: 'home-b' });
    });

    it.each([
        { finalText: 'c\n', intermediateText: 'b\n', expected: '-a\n+c' },
        { finalText: 'a\n', intermediateText: 'b\n', expected: null },
        { finalText: 'c\n', intermediateText: 'unobserved\n', expected: null },
    ])('renders the Session net comparison through its consumed diff map: $expected', async ({ finalText, intermediateText, expected }) => {
        transcriptMessages = [message, createTurnEvidenceMessage({
            id: 'turn-2-evidence', createdAt: 20, turnId: 'turn_2',
            source: 'provider_native', confidence: 'exact',
            oldText: intermediateText, newText: finalText,
            unifiedDiff: `diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-${intermediateText}+${finalText}`,
        })];
        const { useDerivedSessionChangeSet } = await import('./useDerivedSessionChangeSet');
        const { getCurrent } = await renderHook(() => useDerivedSessionChangeSet({ serverId: 'home-b', sessionId: 'session_1' }));
        const diff = getCurrent().providerDiffByPath?.get('src/app.ts');
        if (expected) expect(diff).toContain(expected);
        else expect(diff).toBe(expected);
        expect(getCurrent().latestTurnDiffByPath?.get('src/app.ts')).toContain(`-${intermediateText}+${finalText}`);
    });

    it('composes absolute and relative evidence under the mounted repository path', async () => {
        transcriptMessages = [message, createTurnEvidenceMessage({
            id: 'turn-2-evidence', createdAt: 20, turnId: 'turn_2', filePath: '/repo/src/app.ts',
            source: 'provider_native', confidence: 'exact', oldText: 'b\n', newText: 'c\n',
            unifiedDiff: 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-b\n+c\n',
        })];
        const { useDerivedSessionChangeSet } = await import('./useDerivedSessionChangeSet');
        const { getCurrent } = await renderHook(() => useDerivedSessionChangeSet({ serverId: 'home-b', sessionId: 'session_1' }, '/repo'));
        expect([...getCurrent().providerDiffByPath!.keys()]).toEqual(['src/app.ts']);
        expect(getCurrent().providerDiffByPath?.get('src/app.ts')).toContain('-a\n+c');
    });

    it('clears latest-turn files when the canonical latest turn has no published file evidence', async () => {
        session = { ...session, latestTurnId: 'turn_1', latestTurnStatus: 'completed' };
        const { useDerivedSessionChangeSet } = await import('./useDerivedSessionChangeSet');
        const { useChangedFilesData } = await import('@/hooks/session/files/useChangedFilesData');
        const { getCurrent, rerender } = await renderHook(() => {
            const derived = useDerivedSessionChangeSet({ serverId: 'home-b', sessionId: 'session_1' });
            const files = useChangedFilesData({
                sessionId: 'session_1',
                scmSnapshot: null,
                workspaceTouchedPaths: [],
                searchQuery: '',
                showAllRepositoryFiles: false,
                latestTurnId: derived.latestTurnId,
                latestTurnChangeSet: derived.latestTurnScopedChangeSet,
                latestTurnEvidence: derived.latestTurnChangeSet,
                sessionChangeSet: derived.sessionChangeSet,
            });
            return { derived, files };
        });
        expect(getCurrent().files.turnAttributedFiles.map((entry) => entry.file.fullPath)).toEqual(['src/app.ts']);

        // Both a no-change turn and an unavailable checkpoint intentionally publish no Diff row.
        // The independently published Session lifecycle still advances to their exact turn id.
        session = { ...session, latestTurnId: 'turn_2', latestTurnStatus: 'completed' };
        await rerender();

        expect(getCurrent().derived.latestTurnChangeSet).toBeNull();
        expect(getCurrent().derived.latestTurnScopedChangeSet).toBeNull();
        expect(getCurrent().derived.latestTurnDiffByPath).toBeNull();
        expect(getCurrent().derived.latestTurnAgentReportedDiffByPath).toBeNull();
        expect(getCurrent().derived.latestTurnCheckpointDiffByPath).toBeNull();
        expect(getCurrent().files.turnAttributedFiles).toEqual([]);
        expect(getCurrent().files.showTurnViewToggle).toBe(true);
        expect(getCurrent().files.sessionAttributedFiles.map((entry) => entry.file.fullPath)).toEqual(['src/app.ts']);
        expect(transcriptMessages).toEqual([message]);
    });

    it('presents the canonical patch for a path whatever order the turn evidence arrived in', async () => {
        for (const ordered of [
            [canonicalPatchEvidence, laterProviderEvidence],
            [laterProviderEvidence, canonicalPatchEvidence],
        ]) {
            transcriptMessages = ordered;
            vi.resetModules();
            const { useDerivedSessionChangeSet } = await import('./useDerivedSessionChangeSet');
            const { getCurrent } = await renderHook(() => useDerivedSessionChangeSet({
                serverId: 'home-b',
                sessionId: 'session_1',
            }));

            expect(getCurrent().latestTurnAgentReportedDiffByPath?.get('src/app.ts')).toContain('@@ canonical @@');
        }
    });

    it('presents the canonically latest turn even when its evidence was published first', async () => {
        const laterTurnPublishedFirst = createToolCallMessageFixture({
            id: 'tool-call-turn-2',
            createdAt: 5,
            tool: {
                name: 'Diff', state: 'completed',
                input: {
                    files: [{ file_path: 'src/late.ts', change_kind: 'modified', source: 'provider_native', confidence: 'exact', provider: 'codex', unified_diff: 'late diff' }],
                    _happier: {
                        v: 2, protocol: 'codex', provider: 'codex', rawToolName: 'CodexDiff', canonicalToolName: 'Diff',
                        sessionChangeScope: 'turn', turnId: 'turn_2', sessionId: 'session_1',
                        source: 'provider_native', confidence: 'exact', turnStatus: 'completed',
                        seqRange: { startSeqInclusive: 9, endSeqInclusive: 12 },
                    },
                },
                createdAt: 5, startedAt: 5, completedAt: 6, description: null, result: { status: 'completed' },
            },
        });
        transcriptMessages = [laterTurnPublishedFirst, message];
        vi.resetModules();
        const { useDerivedSessionChangeSet } = await import('./useDerivedSessionChangeSet');
        const { getCurrent } = await renderHook(() => useDerivedSessionChangeSet({
            serverId: 'home-b',
            sessionId: 'session_1',
        }));

        expect(getCurrent().latestTurnChangeSet?.turnId).toBe('turn_2');
    });

    it('derives a session change set and provider diffs from canonical Diff messages', async () => {
        vi.resetModules();
        const { useDerivedSessionChangeSet } = await import('./useDerivedSessionChangeSet');
        const { getCurrent } = await renderHook(() => useDerivedSessionChangeSet({
            serverId: 'home-b',
            sessionId: 'session_1',
        }));
        const current = getCurrent();

        expect(current.sessionChangeSet).toEqual(expect.objectContaining({
            sessionId: 'session_1',
            turns: [expect.objectContaining({ turnId: 'turn_1' })],
        }));
        expect(current.latestTurnChangeSet?.turnId).toBe('turn_1');
        const providerDiffMap = current.providerDiffByPath;
        expect(providerDiffMap).toBeInstanceOf(Map);
        if (!providerDiffMap) {
            throw new Error('Expected provider diff map');
        }
        expect(providerDiffMap.get('src/app.ts')).toContain('diff --git a/src/app.ts b/src/app.ts');
    });

    it('presents the turn a link names, not whichever turn is latest, through the same derivation', async () => {
        transcriptMessages = [
            createTurnEvidenceMessage({ id: 'turn-1-diff', createdAt: 10, source: 'provider_native', confidence: 'exact', turnId: 'turn_1', filePath: 'src/first.ts', unifiedDiff: 'diff --git a/src/first.ts b/src/first.ts\n@@ first @@\n' }),
            createTurnEvidenceMessage({ id: 'turn-2-diff', createdAt: 20, source: 'provider_native', confidence: 'exact', turnId: 'turn_2', filePath: 'src/second.ts', unifiedDiff: 'diff --git a/src/second.ts b/src/second.ts\n@@ second @@\n' }),
        ];
        session = { ...session, latestTurnId: 'turn_2', latestTurnStatus: 'completed' };
        const { useDerivedSessionChangeSet } = await import('./useDerivedSessionChangeSet');
        const presented = (await renderHook(() => useDerivedSessionChangeSet(
            { serverId: 'home-b', sessionId: 'session_1' }, null, { presentedTurnId: 'turn_1' },
        ))).getCurrent();
        expect(presented.latestTurnId).toBe('turn_1');
        expect(presented.latestTurnChangeSet?.turnId).toBe('turn_1');
        expect([...(presented.latestTurnDiffByPath?.keys() ?? [])]).toEqual(['src/first.ts']);

        const latest = (await renderHook(() => useDerivedSessionChangeSet({ serverId: 'home-b', sessionId: 'session_1' }))).getCurrent();
        expect(latest.latestTurnChangeSet?.turnId).toBe('turn_2');

        // A named turn with no published evidence presents nothing, never another turn's files.
        const missing = (await renderHook(() => useDerivedSessionChangeSet(
            { serverId: 'home-b', sessionId: 'session_1' }, null, { presentedTurnId: 'turn_9' },
        ))).getCurrent();
        expect(missing.latestTurnChangeSet).toBeNull();
        expect(missing.latestTurnDiffByPath).toBeNull();
    });

    it('fails closed when the retained bare-id transcript belongs to another Home', async () => {
        vi.resetModules();
        const { useDerivedSessionChangeSet } = await import('./useDerivedSessionChangeSet');
        const { getCurrent } = await renderHook(() => useDerivedSessionChangeSet({
            serverId: 'home-a',
            sessionId: 'session_1',
        }));

        expect(getCurrent()).toMatchObject({
            turnChangeSets: [],
            latestTurnChangeSet: null,
            latestTurnScopedChangeSet: null,
            sessionChangeSet: null,
            latestTurnDiffByPath: null,
            latestTurnAgentReportedDiffByPath: null,
            latestTurnCheckpointDiffByPath: null,
            providerDiffByPath: null,
        });
    });
});
