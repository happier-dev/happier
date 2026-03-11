import type { ImportedMcpInputResolutionV1 } from './materializeImportedMcpServerDrafts';

export type ImportedMcpInputResolutionIssueCode =
    | 'missingSecretName'
    | 'missingSecretValue'
    | 'missingMachineEnvName';

export function getImportedMcpInputResolutionIssues(mapping: ImportedMcpInputResolutionV1 | undefined): ImportedMcpInputResolutionIssueCode[] {
    if (!mapping) return [];

    if (mapping.mode === 'savedSecret') {
        const issues: ImportedMcpInputResolutionIssueCode[] = [];
        if (!mapping.secretName.trim()) {
            issues.push('missingSecretName');
        }
        if (!mapping.secretValue.trim()) {
            issues.push('missingSecretValue');
        }
        return issues;
    }

    if (!mapping.envVarName.trim()) {
        return ['missingMachineEnvName'];
    }

    return [];
}

export function hasImportedMcpInputResolutionIssues(mapping: ImportedMcpInputResolutionV1 | undefined): boolean {
    return getImportedMcpInputResolutionIssues(mapping).length > 0;
}
