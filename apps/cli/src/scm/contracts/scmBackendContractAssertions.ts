import {
    SCM_BACKEND_CAPABILITY_GROUPS,
    SCM_OPERATION_ERROR_CODES,
    ScmBackendCapabilitiesSchema,
    type ScmBackendCapabilities,
    type ScmBackendCapabilityLeaf,
    type ScmOperationErrorCode,
    type ScmWorkingSnapshot,
} from '@happier-dev/protocol';
import { expect } from 'vitest';

export type ScmOperationResult = Readonly<{
    success: boolean;
    errorCode?: ScmOperationErrorCode;
    error?: string;
}>;

export type ScmBackendCapabilityLeafPath = Readonly<{
    group: keyof ScmBackendCapabilities;
    leaf: string;
}>;

export function assertSupportedResult<T extends ScmOperationResult>(
    result: T,
): asserts result is T & { success: true } {
    expect(result.success).toBe(true);
}

export function assertUnsupportedResult(result: ScmOperationResult): void {
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
}

export function assertNotUnsupportedResult(result: ScmOperationResult): void {
    expect(result.errorCode).not.toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
}

export function assertGroupedCapabilities(capabilities: ScmBackendCapabilities): ScmBackendCapabilities {
    const parsed = ScmBackendCapabilitiesSchema.parse(capabilities);
    for (const group of SCM_BACKEND_CAPABILITY_GROUPS) {
        expect(parsed[group]).toBeDefined();
    }
    return parsed;
}

export function isScmBackendCapabilityLeaf(value: unknown): value is ScmBackendCapabilityLeaf {
    return Boolean(
        value
        && typeof value === 'object'
        && !Array.isArray(value)
        && 'support' in value
        && typeof (value as { support?: unknown }).support === 'string',
    );
}

export function listCapabilityLeaves(
    capabilities: ScmBackendCapabilities,
): readonly ScmBackendCapabilityLeafPath[] {
    const leaves: ScmBackendCapabilityLeafPath[] = [];
    for (const group of SCM_BACKEND_CAPABILITY_GROUPS) {
        const value = capabilities[group];
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        for (const [leaf, leafValue] of Object.entries(value)) {
            if (isScmBackendCapabilityLeaf(leafValue)) {
                leaves.push({ group, leaf });
            }
        }
    }
    return leaves;
}

export function getCapabilityLeaf(
    capabilities: ScmBackendCapabilities,
    path: ScmBackendCapabilityLeafPath,
): ScmBackendCapabilityLeaf | null {
    const group = capabilities[path.group];
    if (!group || typeof group !== 'object' || Array.isArray(group)) return null;
    const leaf = (group as Record<string, unknown>)[path.leaf];
    return isScmBackendCapabilityLeaf(leaf) ? leaf : null;
}

export function assertUnsupportedCapabilityLeaf(
    capabilities: ScmBackendCapabilities,
    path: ScmBackendCapabilityLeafPath,
): void {
    const leaf = getCapabilityLeaf(capabilities, path);
    expect(leaf).not.toBeNull();
    expect(leaf?.support).toBe('unsupported');
    expect(leaf?.reason).toBeDefined();
}

export function assertSnapshotHasOnlyTrackedContractPaths(
    snapshot: ScmWorkingSnapshot,
    paths: Readonly<{
        included: string;
        excluded: string;
    }>,
): void {
    const snapshotPaths = snapshot.entries.map((entry) => entry.path);
    expect(snapshotPaths).toContain(paths.included);
    expect(snapshotPaths).not.toContain(paths.excluded);
}
