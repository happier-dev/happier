import Constants from 'expo-constants';

import { randomUUID } from '@/platform/randomUUID';

export type TerminalQaBuildIdentity = Readonly<{
    buildEvidenceId: string;
    sourceStateSha256: string;
    dependencyClosureSha256: string;
}>;

export type TerminalQaRunIdentity = TerminalQaBuildIdentity & Readonly<{
    runId: string;
    runNonce: string;
}>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BUILD_ID_PATTERN = /^term-build-[A-Za-z0-9_-]{16,128}$/;

export function readTerminalQaBuildIdentity(
    expoConfig: unknown = Constants.expoConfig,
): TerminalQaBuildIdentity | null {
    if (!expoConfig || typeof expoConfig !== 'object') return null;
    const extra = (expoConfig as { extra?: unknown }).extra;
    if (!extra || typeof extra !== 'object') return null;
    const app = (extra as { app?: unknown }).app;
    if (!app || typeof app !== 'object') return null;
    const identity = (app as { terminalNativeEvidenceBuildIdentity?: unknown }).terminalNativeEvidenceBuildIdentity;
    if (!identity || typeof identity !== 'object') return null;
    const candidate = identity as Record<string, unknown>;
    if (
        typeof candidate.buildEvidenceId !== 'string'
        || !BUILD_ID_PATTERN.test(candidate.buildEvidenceId)
        || typeof candidate.sourceStateSha256 !== 'string'
        || !SHA256_PATTERN.test(candidate.sourceStateSha256)
        || typeof candidate.dependencyClosureSha256 !== 'string'
        || !SHA256_PATTERN.test(candidate.dependencyClosureSha256)
    ) return null;
    return Object.freeze({
        buildEvidenceId: candidate.buildEvidenceId,
        sourceStateSha256: candidate.sourceStateSha256,
        dependencyClosureSha256: candidate.dependencyClosureSha256,
    });
}

export function createTerminalQaRunIdentity(buildIdentity: TerminalQaBuildIdentity): TerminalQaRunIdentity {
    const firstNoncePart = randomUUID().replaceAll('-', '');
    const secondNoncePart = randomUUID().replaceAll('-', '');
    return Object.freeze({
        ...buildIdentity,
        runId: `term-run-${randomUUID()}`,
        runNonce: `${firstNoncePart}${secondNoncePart}`,
    });
}
