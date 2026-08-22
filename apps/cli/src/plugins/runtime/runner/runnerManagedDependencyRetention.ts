import { z } from 'zod';

import { PluginIdSchema } from '@happier-dev/protocol';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

const HostPluginIdSchema = asHostProtocolZod(PluginIdSchema);

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
    immutableGenerationId: z.string().trim().min(1).max(512),
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
    immutableGenerationId:
        z.string().trim().min(1).max(512),
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
    ) || left.immutableGenerationId.localeCompare(
        right.immutableGenerationId,
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
        && left.immutableGenerationId === right.immutableGenerationId
        && left.manifestAuthority === right.manifestAuthority
        && left.hardRevocationRevisionAtAdmission
            === right.hardRevocationRevisionAtAdmission;
}

export const RunnerManagedDependencyRetentionV1Schema = z.object({
    v: z.literal(1),
    adoptedManagedProviderAuthority:
        RunnerManagedProviderRetainedAuthorityV1Schema.optional(),
    sourceGenerationIds:
        SortedUniqueBoundedStringsSchema(64),
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
                sourceCandidate.immutableGenerationId,
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
            sourceGenerationIds: [
                ...new Set(
                    values.flatMap(
                        (value) =>
                            value?.sourceGenerationIds ?? [],
                    ),
                ),
            ].sort(),
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
