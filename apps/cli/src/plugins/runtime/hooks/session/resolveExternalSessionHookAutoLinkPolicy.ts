import {
    deriveExternalSessionsAutoLinkSourcePolicyIdV1,
    ExternalSessionsSourceSchema,
    readExternalSessionsSettingsV1,
    type AccountSettings,
    type ExternalSessionsSource,
    type LinkedExternalSessionQualifiedIdentityV1,
} from '@happier-dev/protocol';

import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { deepEqual } from '@/utils/deterministicJson';

type SourceKeyOwner = Readonly<{
    sourceKey: string;
}>;

export type ResolveExternalSessionHookAutoLinkPolicyDependencies = Readonly<{
    readAccountSettings?(): AccountSettings | null;
    readAccountScopeKey?(): string | null;
    resolveSourceKeyOwner(
        agentId: string,
        source: ExternalSessionsSource,
    ): Promise<SourceKeyOwner | null>;
}>;

type ReadExternalSessionHookAutoLinkPolicyDependencies = Readonly<{
    readAccountSettings?(): AccountSettings | null;
    readAccountScopeKey?(): string | null;
}>;

function readExternalSessionHookAutoLinkPolicy(
    input: Readonly<{
        machineId: string;
        qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
        sourcePolicyId: string;
    }>,
    dependencies: ReadExternalSessionHookAutoLinkPolicyDependencies,
): Readonly<{
    accountScopeKey: string;
    sourcePolicyId: string;
    enabledAtMs: number;
}> | null {
    const activeSnapshot = dependencies.readAccountSettings
        ? null
        : getActiveAccountSettingsSnapshot();
    const accountScopeKey = (
        dependencies.readAccountScopeKey?.()
        ?? activeSnapshot?.scopeKey
        ?? ''
    ).trim();
    if (accountScopeKey.length === 0) return null;
    const settings = readExternalSessionsSettingsV1(
        (
            dependencies.readAccountSettings?.()
            ?? activeSnapshot?.settings
        )?.externalSessionsSettingsV1,
    );
    const policy = settings?.autoLinkSourcePolicies.find((candidate) => (
        candidate.machineId === input.machineId
        && candidate.sourcePolicyId === input.sourcePolicyId
        && deepEqual(
            candidate.qualifiedIdentity,
            input.qualifiedIdentity,
        )
    ));
    return policy
        ? {
            accountScopeKey,
            sourcePolicyId: policy.sourcePolicyId,
            enabledAtMs: policy.enabledAtMs,
        }
        : null;
}

export function isExternalSessionHookAutoLinkPolicyCurrent(
    input: Readonly<{
        machineId: string;
        qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
        sourcePolicyId: string;
        enabledAtMs: number;
        accountScopeKey: string;
    }>,
    dependencies: ReadExternalSessionHookAutoLinkPolicyDependencies = {},
): boolean {
    const current = readExternalSessionHookAutoLinkPolicy(input, dependencies);
    return current?.accountScopeKey === input.accountScopeKey
        && current.sourcePolicyId === input.sourcePolicyId
        && current.enabledAtMs === input.enabledAtMs;
}

export async function resolveExternalSessionHookAutoLinkPolicy(
    input: Readonly<{
        machineId: string;
        agentId: string;
        qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
        source: unknown;
    }>,
    dependencies: ResolveExternalSessionHookAutoLinkPolicyDependencies,
): Promise<Readonly<{
    accountScopeKey: string;
    canonicalResolvedSourceKey: string;
    sourcePolicyId: string;
    enabledAtMs: number;
}> | null> {
    const parsedSource = ExternalSessionsSourceSchema.safeParse(input.source);
    if (!parsedSource.success) return null;
    const sourceKeyOwner = await dependencies.resolveSourceKeyOwner(
        input.agentId,
        parsedSource.data,
    );
    if (!sourceKeyOwner) return null;
    const sourcePolicyId = deriveExternalSessionsAutoLinkSourcePolicyIdV1({
        machineId: input.machineId,
        qualifiedIdentity: input.qualifiedIdentity,
        canonicalResolvedSourceKey: sourceKeyOwner.sourceKey,
    });
    const policy = readExternalSessionHookAutoLinkPolicy({
        machineId: input.machineId,
        qualifiedIdentity: input.qualifiedIdentity,
        sourcePolicyId,
    }, dependencies);
    return policy
        ? {
            ...policy,
            canonicalResolvedSourceKey: sourceKeyOwner.sourceKey,
        }
        : null;
}
