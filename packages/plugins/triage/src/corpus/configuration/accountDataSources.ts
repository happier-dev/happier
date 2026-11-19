import { admitTriageSourceDescriptorV1, type TriageSourceDescriptorV1 } from '@happier-dev/triage-protocol/v1';
import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import { renderSourceQualifiedId } from '../identity/components.js';
import type { CorpusRowV1 } from '../collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../collections/rows.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../collections/ids.js';

/**
 * The admitted view, keyed the one way this plugin addresses a source.
 *
 * Three readers ask the same question — the aggregate list binds each configured
 * connection to its contribution, the Composer resolves an attached entry
 * through its own source's `get`, and the detail read names that source in the
 * source's own words — and each spelled the join itself. One of them indexing
 * on `contributor.pluginId` alone would mount one source's contribution under
 * another's contribution id, so the key is the same qualified id the configured
 * row is stored under and there is one owner of it.
 */
export function indexTriageAdmittedSourcesV1<T extends {
    contributor: { pluginId: string; contributionId: string }; descriptor?: unknown;
}>(admitted: readonly T[]): ReadonlyMap<string, Omit<T, 'descriptor'> & { descriptor: TriageSourceDescriptorV1 }> {
    const byQualifiedId = new Map<string, Omit<T, 'descriptor'> & { descriptor: TriageSourceDescriptorV1 }>();
    for (const contribution of admitted) {
        const admission = admitTriageSourceDescriptorV1(contribution.descriptor);
        if (!admission.ok) continue;
        byQualifiedId.set(renderSourceQualifiedId({
            pluginId: contribution.contributor.pluginId,
            localId: contribution.contributor.contributionId,
        }), { ...contribution, descriptor: admission.descriptor });
    }
    return byQualifiedId;
}

export type AccountDataSourceRecordV1 = CorpusRowV1<CorpusSourceInstanceRowV1>;
export type AccountDataSourceReadOptionsV1 = PluginCancellationOptions & Readonly<{
    accountDataSources?: readonly AccountDataSourceRecordV1[];
}>;

/** Project setup-free Account instances from admitted descriptors, without a
 * connection row, setup Action, registry or credential materialization. */
export function readAccountDataSourceRecordsV1(sources: ReadonlyMap<string, {
    contributor: { pluginId: string; contributionId: string }; descriptor: TriageSourceDescriptorV1;
}>): readonly AccountDataSourceRecordV1[] {
    return Array.from(sources.values()).flatMap(source => {
        const declaration = source.descriptor.accountDataInstance;
        return declaration ? [createAccountDataSourceRecordV1(source.contributor, declaration)] : [];
    });
}

/** Stored predecessors of a declaration address the same Account inventory. */
export function projectAccountDataSourceCatalogV1(
    records: readonly AccountDataSourceRecordV1[], builtin: readonly AccountDataSourceRecordV1[],
    includeBuiltin = true,
): readonly AccountDataSourceRecordV1[] {
    return [...(includeBuiltin ? builtin : []), ...records.filter(record => !builtin.some(candidate =>
        candidate.value.sourceQualifiedId === record.value.sourceQualifiedId
        && candidate.value.configured.localInstanceKey === record.value.configured.localInstanceKey
        && candidate.value.configured.binding.purpose === record.value.configured.binding.purpose
        && pluginJsonValuesEqual(candidate.value.configured.configuration, record.value.configured.configuration)
        && 'source' in record.value.configured.binding && record.value.configured.binding.source === 'accountData'))];
}

/** The built-in source uses the same projection and preserves its existing address. */
export function createAccountDataSourceRecordV1(
    contributor: { pluginId: string; contributionId: string },
    declaration: NonNullable<TriageSourceDescriptorV1['accountDataInstance']>,
): AccountDataSourceRecordV1 {
    const { sourceInstanceId, configurationRowId, draft } = declaration;
    return {
        rowId: configurationRowId, revision: 1,
        value: {
            instanceTag: configurationRowId,
            sourceQualifiedId: `${contributor.pluginId}/${contributor.contributionId}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 0,
            configured: { v: 1, instance: { source: {
                pluginId: contributor.pluginId, localId: contributor.contributionId,
            }, sourceInstanceId }, binding: draft.binding, localInstanceKey: draft.localInstanceKey,
            configuration: draft.configuration, locator: draft.locator },
        },
    };
}
