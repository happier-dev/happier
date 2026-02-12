import { describe, expect, it } from 'vitest';

import type { ScmProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';
import type { ScmFileStatus } from './scmStatusFiles';
import {
    buildChangedFilesAttribution,
    canOfferSessionChangedFilesView,
    getDefaultChangedFilesViewMode,
    getSessionAttributionReliability,
    type SessionAttributionConfidence,
} from './scmAttribution';

function makeFile(path: string): ScmFileStatus {
    return {
        fileName: path.split('/').at(-1) || path,
        filePath: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
        fullPath: path,
        status: 'modified',
        isIncluded: false,
        linesAdded: 1,
        linesRemoved: 0,
    };
}

function makeLog(
    entry: Partial<ScmProjectOperationLogEntry> & Pick<ScmProjectOperationLogEntry, 'operation' | 'status' | 'timestamp'>
): ScmProjectOperationLogEntry {
    return {
        id: `log-${entry.timestamp}`,
        sessionId: 'session-1',
        operation: entry.operation,
        status: entry.status,
        timestamp: entry.timestamp,
        detail: entry.detail,
    };
}

function confidenceForPath(
    attributed: Array<{ file: ScmFileStatus; confidence: SessionAttributionConfidence }>,
    path: string
): SessionAttributionConfidence | null {
    const match = attributed.find((entry) => entry.file.fullPath === path);
    return match?.confidence ?? null;
}

describe('buildChangedFilesAttribution', () => {
    it('uses repository view as the default changed-files mode', () => {
        expect(getDefaultChangedFilesViewMode()).toBe('repository');
    });

    it('marks files directly staged/unstaged by this session as high confidence', () => {
        const files = [makeFile('src/high.ts')];
        const result = buildChangedFilesAttribution({
            allChangedFiles: files,
            touchedPaths: [],
            operationLog: [
                makeLog({
                    operation: 'stage',
                    status: 'success',
                    timestamp: 1000,
                    detail: 'src/high.ts',
                }),
            ],
        });

        expect(confidenceForPath(result.sessionAttributedFiles, 'src/high.ts')).toBe('high');
    });

    it('marks touched-only files as inferred and leaves unrelated files as repository-only', () => {
        const files = [makeFile('src/inferred.ts'), makeFile('src/repo-only.ts')];
        const result = buildChangedFilesAttribution({
            allChangedFiles: files,
            touchedPaths: ['src/inferred.ts'],
            operationLog: [],
        });

        expect(confidenceForPath(result.sessionAttributedFiles, 'src/inferred.ts')).toBe('inferred');
        expect(confidenceForPath(result.sessionAttributedFiles, 'src/repo-only.ts')).toBeNull();
        expect(result.repositoryOnlyFiles.map((entry) => entry.fullPath)).toEqual(['src/repo-only.ts']);
    });

    it('ignores non-file operation details to avoid false high-confidence attribution', () => {
        const files = [makeFile('src/a.ts')];
        const result = buildChangedFilesAttribution({
            allChangedFiles: files,
            touchedPaths: [],
            operationLog: [
                makeLog({
                    operation: 'stage',
                    status: 'success',
                    timestamp: 2000,
                    detail: '3 selected lines',
                }),
            ],
        });

        expect(result.sessionAttributedFiles).toEqual([]);
        expect(result.repositoryOnlyFiles.map((entry) => entry.fullPath)).toEqual(['src/a.ts']);
    });

    it('treats path-prefixed operation detail metadata as high confidence', () => {
        const files = [makeFile('src/a.ts')];
        const result = buildChangedFilesAttribution({
            allChangedFiles: files,
            touchedPaths: [],
            operationLog: [
                makeLog({
                    operation: 'stage',
                    status: 'success',
                    timestamp: 2001,
                    detail: 'src/a.ts (3 selected lines)',
                }),
            ],
        });

        expect(confidenceForPath(result.sessionAttributedFiles, 'src/a.ts')).toBe('high');
        expect(result.repositoryOnlyFiles).toEqual([]);
    });

    it('uses structured operation path metadata when available', () => {
        const files = [makeFile('src/structured.ts')];
        const result = buildChangedFilesAttribution({
            allChangedFiles: files,
            touchedPaths: [],
            operationLog: [
                {
                    ...makeLog({
                        operation: 'stage',
                        status: 'success',
                        timestamp: 2002,
                        detail: '3 selected lines',
                    }),
                    path: 'src/structured.ts',
                } as any,
            ],
        });

        expect(confidenceForPath(result.sessionAttributedFiles, 'src/structured.ts')).toBe('high');
        expect(result.repositoryOnlyFiles).toEqual([]);
    });

    it('orders high-confidence session files before inferred files', () => {
        const files = [makeFile('src/inferred.ts'), makeFile('src/high.ts')];
        const result = buildChangedFilesAttribution({
            allChangedFiles: files,
            touchedPaths: ['src/inferred.ts'],
            operationLog: [
                makeLog({
                    operation: 'stage',
                    status: 'success',
                    timestamp: 3000,
                    detail: 'src/high.ts',
                }),
            ],
        });

        expect(result.sessionAttributedFiles.map((entry) => `${entry.file.fullPath}:${entry.confidence}`)).toEqual([
            'src/high.ts:high',
            'src/inferred.ts:inferred',
        ]);
    });

    it('can suppress inferred attribution for lower-reliability session mode', () => {
        const files = [makeFile('src/inferred.ts'), makeFile('src/high.ts')];
        const result = buildChangedFilesAttribution({
            allChangedFiles: files,
            touchedPaths: ['src/inferred.ts'],
            operationLog: [
                makeLog({
                    operation: 'stage',
                    status: 'success',
                    timestamp: 3001,
                    detail: 'src/high.ts',
                }),
            ],
            includeInferred: false,
        });

        expect(result.sessionAttributedFiles.map((entry) => `${entry.file.fullPath}:${entry.confidence}`)).toEqual([
            'src/high.ts:high',
        ]);
        expect(result.repositoryOnlyFiles.map((entry) => entry.fullPath)).toEqual(['src/inferred.ts']);
        expect(result.suppressedInferredCount).toBe(1);
    });
});

describe('getSessionAttributionReliability', () => {
    it('returns high when no other session is active on the same repository', () => {
        expect(
            getSessionAttributionReliability({
                otherSessionCountInProject: 0,
            })
        ).toBe('high');
    });

    it('returns limited when one or more other sessions share the same repository', () => {
        expect(
            getSessionAttributionReliability({
                otherSessionCountInProject: 1,
            })
        ).toBe('limited');

        expect(
            getSessionAttributionReliability({
                otherSessionCountInProject: 3,
            })
        ).toBe('limited');
    });
});

describe('canOfferSessionChangedFilesView', () => {
    it('offers session view when reliability is high', () => {
        expect(
            canOfferSessionChangedFilesView({
                reliability: 'high',
                highConfidenceAttributionCount: 0,
            })
        ).toBe(true);
    });

    it('hides session view when reliability is limited and there are no high-confidence files', () => {
        expect(
            canOfferSessionChangedFilesView({
                reliability: 'limited',
                highConfidenceAttributionCount: 0,
            })
        ).toBe(false);
    });

    it('offers session view when reliability is limited but direct attribution exists', () => {
        expect(
            canOfferSessionChangedFilesView({
                reliability: 'limited',
                highConfidenceAttributionCount: 2,
            })
        ).toBe(true);
    });
});
