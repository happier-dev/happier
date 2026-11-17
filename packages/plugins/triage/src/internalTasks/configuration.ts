import { createAccountDataSourceRecordV1 } from '../corpus/configuration/accountDataSources.js';
import type { TriageConfiguredSourceInstanceV1, TriageSourceInstanceDraftV1 } from '@happier-dev/triage-protocol/v1';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import type { CorpusRowV1 } from '../corpus/collections/rowCodec.js';
import type { CorpusSourceInstanceRowV1 } from '../corpus/collections/rows.js';
import { INTERNAL_TASK_SOURCE_V1, INTERNAL_TASK_SOURCE_LABEL_V1 } from './identity.js';

export const INTERNAL_TASK_DRAFT_V1 = {
  v: 1, binding: { purpose: 'tasks', source: 'accountData' }, localInstanceKey: 'personal', keyStability: 'stable',
  configuration: { v: 1, token: 'happier-tasks-v1' }, locator: { v: 1, displayLabel: INTERNAL_TASK_SOURCE_LABEL_V1 },
} as const satisfies TriageSourceInstanceDraftV1;

export const INTERNAL_TASK_ACCOUNT_DATA_INSTANCE_V1 = {
  sourceInstanceId: '469228ab-360b-45c2-8b89-9b7ce0505797', configurationRowId: 'happier-personal-tasks', draft: INTERNAL_TASK_DRAFT_V1,
} as const;

export function isInternalTaskConfiguredInstanceV1(instance: TriageConfiguredSourceInstanceV1): boolean {
  return instance.instance.source.pluginId === INTERNAL_TASK_SOURCE_V1.pluginId && instance.instance.source.localId === INTERNAL_TASK_SOURCE_V1.localId
    && instance.binding.purpose === INTERNAL_TASK_DRAFT_V1.binding.purpose && 'source' in instance.binding && instance.binding.source === 'accountData'
    && instance.localInstanceKey === INTERNAL_TASK_DRAFT_V1.localInstanceKey && instance.configuration.token === INTERNAL_TASK_DRAFT_V1.configuration.token;
}

/** One built-in Account-data target, with no connection row or setup write.
 * Its fixed revision describes this immutable configuration, not a server row.
 * Task content and Account isolation stay with the existing authenticated todo owner. */
export const INTERNAL_TASK_SOURCE_RECORD_V1: CorpusRowV1<CorpusSourceInstanceRowV1> = Object.freeze(createAccountDataSourceRecordV1(
  { pluginId: INTERNAL_TASK_SOURCE_V1.pluginId, contributionId: INTERNAL_TASK_SOURCE_V1.localId },
  INTERNAL_TASK_ACCOUNT_DATA_INSTANCE_V1,
));

export function readInternalTaskSourceRecordV1(sourceInstanceId: string): CorpusRowV1<CorpusSourceInstanceRowV1> | null {
  return sourceInstanceId === INTERNAL_TASK_SOURCE_RECORD_V1.value.configured.instance.sourceInstanceId
    ? INTERNAL_TASK_SOURCE_RECORD_V1 : null;
}

/** A previously configured personal address remains usable after setup removal. */
export function projectInternalTaskSourceRecordV1(record: CorpusRowV1<CorpusSourceInstanceRowV1>): CorpusRowV1<CorpusSourceInstanceRowV1> {
  return isInternalTaskConfiguredInstanceV1(record.value.configured)
    ? { ...record, value: { ...record.value, lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active } }
    : record;
}
