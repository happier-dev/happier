import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../targetedContributions.js';
import { readAccountDataSourceRecordsV1, type AccountDataSourceReadOptionsV1 } from '../corpus/configuration/accountDataSources.js';
import { indexTriageAdmittedSourcesV1 } from './listEntries.js';

/** Exact-address readers need the same admitted configuration as catalog reads. */
export async function readTriageAccountDataSourceOptionsV1(context: Pick<PluginInvocationContext, 'signal'> & {
    services: Pick<PluginInvocationContext['services'], 'targetedContributions'>;
}): Promise<AccountDataSourceReadOptionsV1> {
    const observation = context.services.targetedContributions.observeForSelf(
        TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated: () => {} },
    );
    try {
        const snapshot = await observation.readCurrent({ signal: context.signal });
        return { signal: context.signal, accountDataSources: readAccountDataSourceRecordsV1(indexTriageAdmittedSourcesV1(snapshot.contributions)) };
    } finally { observation.dispose(); }
}
