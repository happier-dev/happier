import { ExternalSessionTakeoverTargetDirectoryV1Schema } from '@happier-dev/protocol';

import { resolveAbsolutePath } from '@/utils/path/pathUtils';

/**
 * Expands the local-machine home shorthand without otherwise rewriting the
 * path, then delegates admissibility to the public takeover contract.
 */
export function resolveExternalSessionTakeoverTargetDirectory(
    targetDirectory: string,
    targetMachineHomeDir?: string | null,
): string | null {
    const expandedTargetDirectory = resolveAbsolutePath(
        targetDirectory,
        targetMachineHomeDir ?? undefined,
    );
    return ExternalSessionTakeoverTargetDirectoryV1Schema.safeParse(
        expandedTargetDirectory,
    ).success
        ? expandedTargetDirectory
        : null;
}
