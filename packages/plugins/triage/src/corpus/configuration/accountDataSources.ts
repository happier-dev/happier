import type { TriageSourceDescriptorV1 } from '@happier-dev/triage-protocol/v1';
import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import type { CorpusRowV1 } from '../collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../collections/rows.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../collections/ids.js';

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
