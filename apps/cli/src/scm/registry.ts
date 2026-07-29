import type { ScmBackendId, ScmBackendPreference, ScmRepoMode } from '@happier-dev/protocol';

import type { ScmBackend, ScmRepoDetection } from './types';

export type ScmBackendSelection = {
    backend: ScmBackend;
    detection: ScmRepoDetection;
    mode: ScmRepoMode;
};

export type ScmBackendSelectionInput = {
    cwd: string;
    workingDirectory: string;
    backendPreference?: ScmBackendPreference;
};

function modeRank(mode: ScmRepoMode): number {
    if (mode === '.sl') return 100;
    return 50;
}

export function resolveScmBackendById(backends: readonly ScmBackend[], id: ScmBackendId): ScmBackend | null {
    const exact = backends.find((backend) => backend.id === id);
    if (exact) return exact;

    const localMatches = backends.filter((backend) => backend.localId === id);
    return localMatches.length === 1 ? localMatches[0] : null;
}

function resolveModeSelectionScore(input: { backend: ScmBackend; mode: ScmRepoMode }): number {
    return input.backend.selection.modeSelectionScores[input.mode] ?? 0;
}

function isPreferenceAllowedForMode(input: { backend: ScmBackend; mode: ScmRepoMode }): boolean {
    const allowedModes = input.backend.selection.preferenceAllowedModes ?? ['.git'];
    return allowedModes.includes(input.mode);
}

export function createScmBackendRegistry(backends: readonly ScmBackend[]) {
    async function detectAll(input: { cwd: string }): Promise<Array<{ backend: ScmBackend; detection: ScmRepoDetection }>> {
        const results = await Promise.allSettled(
            backends.map(async (backend) => ({
                backend,
                detection: await backend.detectRepo({ cwd: input.cwd }),
            }))
        );
        const detectedRepositories = results.flatMap((result) => (
            result.status === 'fulfilled'
            && result.value.detection.isRepo
            && result.value.detection.mode !== null
                ? [result.value]
                : []
        ));
        if (detectedRepositories.length > 0) return detectedRepositories;

        const detectorFailure = results.find((result) => result.status === 'rejected');
        if (detectorFailure?.status === 'rejected') throw detectorFailure.reason;
        return [];
    }

    async function selectBackend(input: ScmBackendSelectionInput): Promise<ScmBackendSelection | null> {
        const detections = await detectAll({ cwd: input.cwd });
        if (detections.length === 0) return null;

        const preference = input.backendPreference;
        if (preference?.kind === 'prefer') {
            const preferredBackend = resolveScmBackendById(backends, preference.backendId);
            const preferredDetection = detections.find((entry) => entry.backend.id === preferredBackend?.id);
            if (
                preferredDetection
                && preferredDetection.detection.mode
                && isPreferenceAllowedForMode({
                    backend: preferredDetection.backend,
                    mode: preferredDetection.detection.mode,
                })
            ) {
                return {
                    backend: preferredDetection.backend,
                    detection: preferredDetection.detection,
                    mode: preferredDetection.detection.mode,
                };
            }
        }

        const best = detections
            .slice()
            .sort((a, b) => {
                const modeScoreA = resolveModeSelectionScore({ backend: a.backend, mode: a.detection.mode! });
                const modeScoreB = resolveModeSelectionScore({ backend: b.backend, mode: b.detection.mode! });
                if (modeScoreA !== modeScoreB) {
                    return modeScoreB - modeScoreA;
                }
                return modeRank(b.detection.mode!) - modeRank(a.detection.mode!);
            })[0];
        if (!best || !best.detection.mode) return null;

        return {
            backend: best.backend,
            detection: best.detection,
            mode: best.detection.mode,
        };
    }

    return {
        listBackends: () => backends,
        selectBackend,
    };
}

export type ScmBackendRegistry = ReturnType<typeof createScmBackendRegistry>;
