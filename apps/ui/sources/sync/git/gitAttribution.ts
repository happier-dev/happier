import type { GitFileStatus } from './gitStatusFiles';
import type { GitProjectOperationLogEntry } from '../projectManager';

export type SessionAttributionConfidence = 'high' | 'inferred';
export type ChangedFilesViewMode = 'repository' | 'session';
export type SessionAttributionReliability = 'high' | 'limited';

export type SessionAttributedFile = {
    file: GitFileStatus;
    confidence: SessionAttributionConfidence;
};

function resolveOperationDetailPath(detail: string, knownPaths: ReadonlySet<string>): string | null {
    const trimmed = detail.trim();
    if (!trimmed) return null;
    if (knownPaths.has(trimmed)) return trimmed;

    const separators = [' (', ' [', ' {', '\t', ' |'];
    for (const separator of separators) {
        const index = trimmed.indexOf(separator);
        if (index <= 0) continue;
        const candidate = trimmed.slice(0, index).trim();
        if (candidate && knownPaths.has(candidate)) {
            return candidate;
        }
    }

    if (trimmed.startsWith('path=')) {
        const candidate = trimmed.slice('path='.length).trim();
        if (candidate && knownPaths.has(candidate)) {
            return candidate;
        }
    }

    return null;
}

export function getDefaultChangedFilesViewMode(): ChangedFilesViewMode {
    return 'repository';
}

export function getSessionAttributionReliability(input: {
    otherSessionCountInProject: number;
}): SessionAttributionReliability {
    return input.otherSessionCountInProject > 0 ? 'limited' : 'high';
}

export function canOfferSessionChangedFilesView(input: {
    reliability: SessionAttributionReliability;
    highConfidenceAttributionCount: number;
}): boolean {
    if (input.reliability === 'high') {
        return true;
    }
    return input.highConfidenceAttributionCount > 0;
}

export function buildChangedFilesAttribution(input: {
    allChangedFiles: GitFileStatus[];
    touchedPaths: string[];
    operationLog: GitProjectOperationLogEntry[];
    includeInferred?: boolean;
}): {
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: GitFileStatus[];
    suppressedInferredCount: number;
} {
    const includeInferred = input.includeInferred ?? true;
    const touchedSet = new Set(input.touchedPaths);
    const directPathSet = new Set<string>();
    const knownPaths = new Set(input.allChangedFiles.map((file) => file.fullPath));

    for (const entry of input.operationLog) {
        if (entry.status !== 'success') continue;
        if (entry.operation !== 'stage' && entry.operation !== 'unstage') continue;
        if (entry.path && knownPaths.has(entry.path)) {
            directPathSet.add(entry.path);
            continue;
        }
        const detail = entry.detail?.trim();
        if (!detail) continue;
        const path = resolveOperationDetailPath(detail, knownPaths);
        if (path) {
            directPathSet.add(path);
            continue;
        }
        // Backward compatibility: accept old plain path-like details when they still match a changed path.
        if ((detail.includes('/') || detail.includes('.')) && knownPaths.has(detail)) {
            directPathSet.add(detail);
        }
    }

    const sessionAttributedFiles: SessionAttributedFile[] = [];
    const repositoryOnlyFiles: GitFileStatus[] = [];
    let suppressedInferredCount = 0;

    for (const file of input.allChangedFiles) {
        if (directPathSet.has(file.fullPath)) {
            sessionAttributedFiles.push({ file, confidence: 'high' });
            continue;
        }
        if (touchedSet.has(file.fullPath)) {
            if (includeInferred) {
                sessionAttributedFiles.push({ file, confidence: 'inferred' });
            } else {
                repositoryOnlyFiles.push(file);
                suppressedInferredCount += 1;
            }
            continue;
        }
        repositoryOnlyFiles.push(file);
    }

    sessionAttributedFiles.sort((a, b) => {
        if (a.confidence === b.confidence) {
            return a.file.fullPath.localeCompare(b.file.fullPath);
        }
        return a.confidence === 'high' ? -1 : 1;
    });

    return { sessionAttributedFiles, repositoryOnlyFiles, suppressedInferredCount };
}
