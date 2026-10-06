import { z } from 'zod';

import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { PluginSourceCustodyV1Schema, pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { PluginSourceCustodyV1 } from '@happier-dev/protocol';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

const HostPluginIdSchema = asHostProtocolZod(PluginIdSchema);
const HostPluginSourceCustodyV1Schema = asHostProtocolZod(
    PluginSourceCustodyV1Schema,
);

export function runnerPluginSourceCustodyIdentity(
    value: PluginSourceCustodyV1,
): string {
    if (value.kind === 'managed') {
        return `managed:${value.installSource}:${value.immutableGenerationId}`;
    }
    if (value.kind === 'development') {
        return `development:${value.registeredRootId}`;
    }
    return value.packagedRuntime.kind === 'cli_version_root'
        ? `bundled_first_party:cli_version_root:${value.packagedRuntime.versionRootId}`
        : `bundled_first_party:pinned_runner_snapshot:${value.packagedRuntime.snapshotId}`;
}

const SortedUniqueBoundedStringsSchema = (
    maxEntries: number,
) => z.array(
    z.string().trim().min(1).max(512),
).max(maxEntries).superRefine((values, context) => {
    if (
        new Set(values).size !== values.length
        || values.some((value, index) => (
            index > 0 && values[index - 1]! >= value
        ))
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Runner managed-dependency retention facts must be unique and sorted',
        });
    }
});

export const RunnerManagedProviderRetainedAuthorityV1Schema = z.object({
    pluginId: HostPluginIdSchema,
    sourceCustody: HostPluginSourceCustodyV1Schema,
    manifestAuthority: z.enum(['external', 'bundled_first_party']),
    hardRevocationRevisionAtAdmission:
        z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export type RunnerManagedProviderRetainedAuthorityV1 = Readonly<z.infer<
    typeof RunnerManagedProviderRetainedAuthorityV1Schema
>>;

export const RunnerManagedDependencySourceCandidateV1Schema = z.object({
    qualifiedDependencyId:
        z.string().trim().min(1).max(512),
    sourceCustody: HostPluginSourceCustodyV1Schema,
    manifestAuthority:
        z.enum(['external', 'bundled_first_party']),
}).strict();

export type RunnerManagedDependencySourceCandidateV1 = Readonly<z.infer<
    typeof RunnerManagedDependencySourceCandidateV1Schema
>>;

function compareSourceCandidates(
    left: RunnerManagedDependencySourceCandidateV1,
    right: RunnerManagedDependencySourceCandidateV1,
): number {
    return left.qualifiedDependencyId.localeCompare(
        right.qualifiedDependencyId,
    ) || runnerPluginSourceCustodyIdentity(left.sourceCustody).localeCompare(
        runnerPluginSourceCustodyIdentity(right.sourceCustody),
    ) || left.manifestAuthority.localeCompare(
        right.manifestAuthority,
    );
}

const SortedUniqueSourceCandidatesSchema = z.array(
    RunnerManagedDependencySourceCandidateV1Schema,
).max(8_192).superRefine((values, context) => {
    if (values.some((value, index) => (
        index > 0
        && compareSourceCandidates(values[index - 1]!, value) >= 0
    ))) {
        context.addIssue({
            code: 'custom',
            message:
                'Runner managed-dependency source candidates must be unique and sorted',
        });
    }
});

export function areRunnerManagedProviderRetainedAuthoritiesEqual(
    left: RunnerManagedProviderRetainedAuthorityV1 | null | undefined,
    right: RunnerManagedProviderRetainedAuthorityV1 | null | undefined,
): boolean {
    if (!left || !right) return left === right;
    return left.pluginId === right.pluginId
        && pluginSourceCustodyV1Equal(left.sourceCustody, right.sourceCustody)
        && left.manifestAuthority === right.manifestAuthority
        && left.hardRevocationRevisionAtAdmission
            === right.hardRevocationRevisionAtAdmission;
}

export const RunnerManagedDependencyRetentionV1Schema = z.object({
    v: z.literal(1),
    adoptedManagedProviderAuthority:
        RunnerManagedProviderRetainedAuthorityV1Schema.optional(),
    sourceCustodies: z.array(HostPluginSourceCustodyV1Schema).max(64)
        .superRefine((values, context) => {
            const identities = values.map(runnerPluginSourceCustodyIdentity);
            if (identities.some((value, index) => (
                index > 0 && identities[index - 1]! >= value
            ))) {
                context.addIssue({
                    code: 'custom',
                    message: 'Runner source custodies must be unique and sorted',
                });
            }
        }),
    qualifiedDependencyIds:
        SortedUniqueBoundedStringsSchema(8_192),
    sourceCandidates:
        SortedUniqueSourceCandidatesSchema.optional(),
}).strict();

export type RunnerManagedDependencyRetentionV1 = z.infer<
    typeof RunnerManagedDependencyRetentionV1Schema
>;

export function mergeRunnerManagedDependencyRetentionV1(
    ...values: readonly (
        RunnerManagedDependencyRetentionV1 | null | undefined
    )[]
): RunnerManagedDependencyRetentionV1 {
    let adoptedManagedProviderAuthority:
        RunnerManagedProviderRetainedAuthorityV1 | undefined;
    for (const value of values) {
        const authority = value?.adoptedManagedProviderAuthority;
        if (!authority) continue;
        if (
            adoptedManagedProviderAuthority
            && !areRunnerManagedProviderRetainedAuthoritiesEqual(
                adoptedManagedProviderAuthority,
                authority,
            )
        ) {
            throw new Error(
                'Runner retention cannot merge competing adopted Provider authorities',
            );
        }
        adoptedManagedProviderAuthority =
            RunnerManagedProviderRetainedAuthorityV1Schema.parse(authority);
    }
    const sourceCandidatesByIdentity = new Map<
        string,
        RunnerManagedDependencySourceCandidateV1
    >();
    let hasSourceCandidates = false;
    for (const value of values) {
        if (value?.sourceCandidates === undefined) continue;
        hasSourceCandidates = true;
        for (const sourceCandidate of value.sourceCandidates) {
            const identity = JSON.stringify([
                sourceCandidate.qualifiedDependencyId,
                runnerPluginSourceCustodyIdentity(sourceCandidate.sourceCustody),
            ]);
            const existing = sourceCandidatesByIdentity.get(identity);
            if (
                existing
                && existing.manifestAuthority
                    !== sourceCandidate.manifestAuthority
            ) {
                throw new Error(
                    'Runner retention cannot merge competing managed-dependency source-candidate authorities',
                );
            }
            sourceCandidatesByIdentity.set(
                identity,
                RunnerManagedDependencySourceCandidateV1Schema.parse(
                    sourceCandidate,
                ),
            );
        }
    }
    return Object.freeze(
        RunnerManagedDependencyRetentionV1Schema.parse({
            v: 1,
            ...(adoptedManagedProviderAuthority
                ? {
                    adoptedManagedProviderAuthority,
                }
                : {}),
            sourceCustodies: [
                ...new Map(values.flatMap(
                    (value) => value?.sourceCustodies ?? [],
                ).map((custody) => [
                    runnerPluginSourceCustodyIdentity(custody),
                    custody,
                ])).values(),
            ].sort((left, right) => runnerPluginSourceCustodyIdentity(left)
                .localeCompare(runnerPluginSourceCustodyIdentity(right))),
            qualifiedDependencyIds: [
                ...new Set(
                    values.flatMap(
                        (value) =>
                            value?.qualifiedDependencyIds ?? [],
                    ),
                ),
            ].sort(),
            ...(hasSourceCandidates
                ? {
                    sourceCandidates: [
                        ...sourceCandidatesByIdentity.values(),
                    ].sort(compareSourceCandidates),
                }
                : {}),
        }),
    );
}

export function withRunnerManagedProviderAuthorityRetention(
    value: RunnerManagedDependencyRetentionV1 | null | undefined,
    authority: RunnerManagedProviderRetainedAuthorityV1 | null,
): RunnerManagedDependencyRetentionV1 {
    const current = mergeRunnerManagedDependencyRetentionV1(value);
    return Object.freeze(
        RunnerManagedDependencyRetentionV1Schema.parse({
            ...current,
            ...(authority
                ? {
                    adoptedManagedProviderAuthority:
                        RunnerManagedProviderRetainedAuthorityV1Schema
                            .parse(authority),
                }
                : {}),
            ...(!authority
                ? {
                    adoptedManagedProviderAuthority:
                        undefined,
                }
                : {}),
        }),
    );
}
