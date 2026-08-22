import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import type {
    ExternalAgentObservationWatchFileChangesV1,
} from '@happier-dev/protocol';
import {
    ExternalAgentObservationWatchFileChangesV1Schema,
} from '@happier-dev/protocol';
import type {
    AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/sessions/external';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

function collectResolvedSourceAbsoluteRoots(value: unknown): string[] {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return isAbsolute(trimmed) ? [resolve(trimmed)] : [];
    }
    if (Array.isArray(value)) {
        return value.flatMap(collectResolvedSourceAbsoluteRoots);
    }
    if (typeof value !== 'object' || value === null) {
        return [];
    }
    return Object.values(value).flatMap(collectResolvedSourceAbsoluteRoots);
}

function sourceRoots(
    linkedSource: AgentExternalSessionsResolvedIdentity,
): readonly Readonly<{ lexical: string; canonical: string }>[] {
    return collectResolvedSourceAbsoluteRoots(linkedSource.source).map((root) => {
        try {
            return { lexical: root, canonical: realpathSync(root) };
        } catch {
            return { lexical: root, canonical: root };
        }
    });
}

function isAuthorizedBySourceRoot(
    lexicalPath: string,
    canonicalPath: string,
    roots: readonly Readonly<{ lexical: string; canonical: string }>[],
): boolean {
    return roots.some((root) => (
        (
            isCanonicalAbsolutePathInsideRoot(root.lexical, lexicalPath)
            || isCanonicalAbsolutePathInsideRoot(root.canonical, lexicalPath)
        )
        && isCanonicalAbsolutePathInsideRoot(root.canonical, canonicalPath)
    ));
}

function canonicalizeMissingPathFromSourceRoot(
    lexicalPath: string,
    roots: readonly Readonly<{ lexical: string; canonical: string }>[],
): string | null {
    for (const root of roots) {
        if (isCanonicalAbsolutePathInsideRoot(root.canonical, lexicalPath)) {
            return lexicalPath;
        }
        if (isCanonicalAbsolutePathInsideRoot(root.lexical, lexicalPath)) {
            return resolve(root.canonical, relative(root.lexical, lexicalPath));
        }
    }
    return null;
}

export function validateExternalSessionObservationWatchFileChanges(params: Readonly<{
    requested: ExternalAgentObservationWatchFileChangesV1 | undefined;
    linkedSource: AgentExternalSessionsResolvedIdentity;
    filesystemReadAllowedPaths: ReadonlySet<string>;
    previouslyAuthorizedFiles?: ReadonlySet<string>;
}>): ExternalAgentObservationWatchFileChangesV1 | null | undefined {
    if (!params.requested) {
        return undefined;
    }
    if (params.filesystemReadAllowedPaths.size === 0) {
        return null;
    }
    const parsed = ExternalAgentObservationWatchFileChangesV1Schema.safeParse(
        params.requested,
    );
    if (!parsed.success) {
        return null;
    }
    const previouslyAuthorizedFiles = params.previouslyAuthorizedFiles ?? new Set();
    const roots = sourceRoots(params.linkedSource);
    if (roots.length === 0) {
        return null;
    }
    const files: string[] = [];
    for (const requestedFile of parsed.data.files) {
        const lexicalFile = resolve(requestedFile);
        let canonicalFile: string;
        try {
            canonicalFile = realpathSync(lexicalFile);
            if (!statSync(canonicalFile).isFile()) {
                return null;
            }
        } catch {
            canonicalFile = lexicalFile;
            if (!previouslyAuthorizedFiles.has(canonicalFile)) {
                return null;
            }
        }
        if (!isAuthorizedBySourceRoot(lexicalFile, canonicalFile, roots)) {
            return null;
        }
        if (files.includes(canonicalFile)) {
            return null;
        }
        files.push(canonicalFile);
    }
    const topologyDirectories: string[] = [];
    for (const requestedDirectory of parsed.data.topologyDirectories ?? []) {
        const lexicalDirectory = resolve(requestedDirectory);
        let canonicalDirectory: string;
        try {
            canonicalDirectory = realpathSync(lexicalDirectory);
            if (!statSync(canonicalDirectory).isDirectory()) {
                return null;
            }
            if (!isAuthorizedBySourceRoot(
                lexicalDirectory,
                canonicalDirectory,
                roots,
            )) {
                return null;
            }
        } catch {
            const missingCanonicalDirectory =
                canonicalizeMissingPathFromSourceRoot(lexicalDirectory, roots);
            if (!missingCanonicalDirectory) {
                return null;
            }
            canonicalDirectory = missingCanonicalDirectory;
        }
        if (topologyDirectories.includes(canonicalDirectory)) {
            return null;
        }
        topologyDirectories.push(canonicalDirectory);
    }
    return {
        files,
        ...(topologyDirectories.length > 0 ? { topologyDirectories } : {}),
    };
}
