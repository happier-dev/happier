import type { ScmRemoteConfirmPolicy } from './preferences';

export type ScmRemoteConfirmationKind = 'fetch' | 'pull' | 'push';

export function normalizeScmRemoteConfirmPolicy(value: unknown): ScmRemoteConfirmPolicy {
    if (
        value === 'always'
        || value === 'pull_only'
        || value === 'push_only'
        || value === 'never'
    ) {
        return value;
    }
    return 'always';
}

export function shouldConfirmRemoteOperation(
    policy: ScmRemoteConfirmPolicy,
    kind: ScmRemoteConfirmationKind,
): boolean {
    if (kind === 'fetch') return false;

    const normalized = normalizeScmRemoteConfirmPolicy(policy);
    if (normalized === 'always') return true;
    if (normalized === 'pull_only') return kind === 'pull';
    if (normalized === 'push_only') return kind === 'push';
    return false;
}

export function setRemoteConfirmationForKind(
    policy: ScmRemoteConfirmPolicy,
    kind: Extract<ScmRemoteConfirmationKind, 'pull' | 'push'>,
    enabled: boolean,
): ScmRemoteConfirmPolicy {
    const confirmsPull = kind === 'pull' ? enabled : shouldConfirmRemoteOperation(policy, 'pull');
    const confirmsPush = kind === 'push' ? enabled : shouldConfirmRemoteOperation(policy, 'push');

    if (confirmsPull && confirmsPush) return 'always';
    if (confirmsPull) return 'pull_only';
    if (confirmsPush) return 'push_only';
    return 'never';
}
