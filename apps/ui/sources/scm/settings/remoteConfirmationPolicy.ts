import type { ScmRemoteConfirmPolicy } from './preferences';

export type ScmConfirmableRemoteOperation = 'pull' | 'push';

export function shouldConfirmRemoteOperation(
    policy: ScmRemoteConfirmPolicy | null | undefined,
    kind: ScmConfirmableRemoteOperation,
): boolean {
    switch (policy) {
        case 'always':
            return true;
        case 'pull_only':
            return kind === 'pull';
        case 'push_only':
            return kind === 'push';
        case 'never':
            return false;
        default:
            return true;
    }
}

export function setRemoteConfirmationForKind(
    policy: ScmRemoteConfirmPolicy | null | undefined,
    kind: ScmConfirmableRemoteOperation,
    enabled: boolean,
): ScmRemoteConfirmPolicy {
    const nextPull = kind === 'pull'
        ? enabled
        : shouldConfirmRemoteOperation(policy, 'pull');
    const nextPush = kind === 'push'
        ? enabled
        : shouldConfirmRemoteOperation(policy, 'push');

    if (nextPull && nextPush) return 'always';
    if (nextPull) return 'pull_only';
    if (nextPush) return 'push_only';
    return 'never';
}
