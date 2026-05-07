import type { ScmFileStatus } from './scmStatusFiles';
import type { ScmProjectOperationLogEntry } from '@/sync/runtime/orchestration/projectManager';

export type SessionAttributionConfidence = 'high' | 'inferred';
export type ChangedFilesViewMode = 'repository' | 'selected' | 'turn' | 'session';
export type ChangedFilesPresentation = 'list' | 'review';
export type SessionAttributionReliability = 'high' | 'limited';

export type SessionAttributedFile = {
    file: ScmFileStatus;
    confidence: SessionAttributionConfidence;
};

export function getDefaultChangedFilesViewMode(): ChangedFilesViewMode {
    return 'repository';
}

export function getPreferredChangedFilesViewMode(input: {
    showTurnViewToggle: boolean;
    showSessionViewToggle: boolean;
    showSelectedViewToggle?: boolean;
}): ChangedFilesViewMode {
    if (input.showTurnViewToggle) return 'turn';
    if (input.showSessionViewToggle) return 'session';
    if (input.showSelectedViewToggle === true) return 'selected';
    return getDefaultChangedFilesViewMode();
}

export function isChangedFilesViewModeAvailable(input: {
    mode: ChangedFilesViewMode;
    showTurnViewToggle: boolean;
    showSessionViewToggle: boolean;
    showSelectedViewToggle?: boolean;
}): boolean {
    if (input.mode === 'repository') return true;
    if (input.mode === 'selected') return input.showSelectedViewToggle === true;
    if (input.mode === 'turn') return input.showTurnViewToggle;
    return input.showSessionViewToggle;
}

export function resolveChangedFilesViewMode(input: {
    mode: ChangedFilesViewMode;
    showTurnViewToggle: boolean;
    showSessionViewToggle: boolean;
    showSelectedViewToggle?: boolean;
}): ChangedFilesViewMode {
    if (isChangedFilesViewModeAvailable(input)) return input.mode;
    return getPreferredChangedFilesViewMode(input);
}

export function getSelectableChangedFilesViewModes(input: {
    showTurnViewToggle: boolean;
    showSessionViewToggle: boolean;
    showSelectedViewToggle?: boolean;
}): ChangedFilesViewMode[] {
    if (!input.showTurnViewToggle && !input.showSessionViewToggle && input.showSelectedViewToggle !== true) {
        return [];
    }
    return [
        'repository',
        ...(input.showSelectedViewToggle === true ? ['selected' as const] : []),
        ...(input.showTurnViewToggle ? ['turn' as const] : []),
        ...(input.showSessionViewToggle ? ['session' as const] : []),
    ];
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
    allChangedFiles: readonly ScmFileStatus[];
    touchedPaths: readonly string[];
    operationLog: readonly ScmProjectOperationLogEntry[];
    includeInferred?: boolean;
}): {
    sessionAttributedFiles: SessionAttributedFile[];
    repositoryOnlyFiles: ScmFileStatus[];
    suppressedInferredCount: number;
} {
    const includeInferred = input.includeInferred ?? true;
    const touchedSet = new Set(input.touchedPaths);

    const sessionAttributedFiles: SessionAttributedFile[] = [];
    const repositoryOnlyFiles: ScmFileStatus[] = [];
    let suppressedInferredCount = 0;

    for (const file of input.allChangedFiles) {
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
