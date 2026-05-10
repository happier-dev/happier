import type { ScmBackendCapabilities } from '@happier-dev/protocol';
import { expect } from 'vitest';

import {
    getCapabilityLeaf,
    listCapabilityLeaves,
    type ScmBackendCapabilityLeafPath,
} from './scmBackendContractAssertions';
import type { ScmBackendContractOperationInput } from './scmBackendContractCases';

export type ScmBackendContractLeafAccountKind =
    | 'executable'
    | 'unsupported-method'
    | 'no-backend-method'
    | 'blocked';

export type ScmBackendContractLeafAccount = Readonly<{
    path: ScmBackendCapabilityLeafPath;
    kind: ScmBackendContractLeafAccountKind;
    rationale?: string;
    requiresExecutable?: boolean;
    assertUnsupported?: (input: ScmBackendContractOperationInput) => Promise<void>;
    assertSupported?: (input: ScmBackendContractOperationInput) => Promise<void>;
}>;

export function scmCapabilityPathKey(path: ScmBackendCapabilityLeafPath): string {
    return `${path.group}.${path.leaf}`;
}

function requireRationale(account: ScmBackendContractLeafAccount): void {
    expect(account.rationale?.trim()).toBeTruthy();
}

export function assertScmBackendContractLeafCoverage(input: Readonly<{
    backendId: string;
    capabilities: ScmBackendCapabilities;
    accounts: readonly ScmBackendContractLeafAccount[];
}>): void {
    const canonicalLeaves = listCapabilityLeaves(input.capabilities);
    const leafKeys = new Set(canonicalLeaves.map(scmCapabilityPathKey));
    const accountKeys = input.accounts.map((account) => scmCapabilityPathKey(account.path));
    const uniqueAccountKeys = new Set(accountKeys);

    const duplicates = accountKeys.filter((key, index) => accountKeys.indexOf(key) !== index);
    expect(duplicates, `${input.backendId} duplicate SCM contract leaf accounts`).toEqual([]);

    const unknownAccounts = accountKeys.filter((key) => !leafKeys.has(key));
    expect(unknownAccounts, `${input.backendId} SCM contract accounts unknown leaves`).toEqual([]);

    const missingLeaves = canonicalLeaves
        .map(scmCapabilityPathKey)
        .filter((key) => !uniqueAccountKeys.has(key));
    expect(missingLeaves, `${input.backendId} SCM contract missing capability leaf accounts`).toEqual([]);

    for (const account of input.accounts) {
        const key = scmCapabilityPathKey(account.path);
        const leaf = getCapabilityLeaf(input.capabilities, account.path);
        expect(leaf, `${input.backendId} missing SCM capability leaf ${key}`).not.toBeNull();
        if (!leaf) continue;

        if (account.kind === 'no-backend-method' || account.kind === 'blocked') {
            requireRationale(account);
        }

        if (account.kind === 'executable') {
            expect(
                account.assertUnsupported,
                `${input.backendId} executable SCM contract leaf ${key} must assert unsupported behavior`,
            ).toBeTypeOf('function');
            if (leaf.support === 'supported' || leaf.support === 'experimental') {
                expect(
                    account.assertSupported,
                    `${input.backendId} supported SCM contract leaf ${key} must have an executable contract case`,
                ).toBeTypeOf('function');
            }
        }

        if (account.kind === 'unsupported-method') {
            expect(
                leaf.support,
                `${input.backendId} SCM leaf ${key} is covered as unsupported but declares support`,
            ).toBe('unsupported');
            expect(
                account.assertUnsupported,
                `${input.backendId} unsupported SCM contract leaf ${key} must assert typed unsupported behavior`,
            ).toBeTypeOf('function');
        }
    }
}
