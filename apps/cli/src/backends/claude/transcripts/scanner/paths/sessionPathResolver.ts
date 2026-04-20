import { dirname, join } from 'node:path';

import { getProjectPath } from '../../../utils/path';

export function createSessionPathResolver(params: Readonly<{
    sessionId: string | null;
    transcriptPath?: string | null;
    workingDirectory: string;
    claudeConfigDir?: string | null;
}>) {
    const initialProjectDir = getProjectPath(params.workingDirectory, params.claudeConfigDir ?? null);
    const sessionFileOverrides = new Map<string, string>();

    const getProjectDirForSession = (sessionId: string | null | undefined): string => {
        if (!sessionId) return initialProjectDir;
        const override = sessionFileOverrides.get(sessionId);
        return override ? dirname(override) : initialProjectDir;
    };

    const getSessionFilePath = (sessionId: string): string => {
        const override = sessionFileOverrides.get(sessionId);
        return override ?? join(initialProjectDir, `${sessionId}.jsonl`);
    };

    const applyTranscriptPathOverride = (sessionId: string, transcriptPath: string | null | undefined): boolean => {
        const normalizedTranscriptPath = typeof transcriptPath === 'string' && transcriptPath.trim()
            ? transcriptPath.trim()
            : null;
        if (!normalizedTranscriptPath) {
            return false;
        }

        let didUpdatePaths = false;
        const prevOverride = sessionFileOverrides.get(sessionId);
        if (prevOverride !== normalizedTranscriptPath) {
            sessionFileOverrides.set(sessionId, normalizedTranscriptPath);
            didUpdatePaths = true;
        }

        return didUpdatePaths;
    };

    if (params.sessionId) {
        applyTranscriptPathOverride(params.sessionId, params.transcriptPath ?? null);
    }

    return {
        applyTranscriptPathOverride,
        getProjectDirForSession,
        getSessionFilePath,
    };
}
