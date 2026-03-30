import { act } from 'react-test-renderer';

type CleanupTarget = Readonly<{
    unmount: () => void;
}>;

const cleanupTargets = new Set<CleanupTarget>();

export function registerStandardCleanupTarget(target: CleanupTarget | null | undefined): void {
    if (!target) return;
    cleanupTargets.add(target);
}

export function unregisterStandardCleanupTarget(target: CleanupTarget | null | undefined): void {
    if (!target) return;
    cleanupTargets.delete(target);
}

export function standardCleanup(): void {
    for (const target of cleanupTargets) {
        try {
            act(() => {
                target.unmount();
            });
        } catch {
            // Cleanup should never mask the test failure that triggered it.
        }
    }
    cleanupTargets.clear();
}
