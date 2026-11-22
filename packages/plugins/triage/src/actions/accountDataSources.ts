import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../targetedContributions.js';
import { indexTriageAdmittedSourcesV1, readAccountDataSourceRecordsV1, type AccountDataSourceReadOptionsV1 } from '../corpus/configuration/accountDataSources.js';

type SourceReadContext = Pick<PluginInvocationContext, 'signal'> & {
    services: Pick<PluginInvocationContext['services'], 'targetedContributions'>;
};

export async function readTriageAdmittedSourceIndexV1(context: SourceReadContext) {
    const observation = context.services.targetedContributions.observeForSelf(
        TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated: () => {} },
    );
    try {
        const snapshot = await observation.readCurrent({ signal: context.signal });
        return indexTriageAdmittedSourcesV1(snapshot.contributions);
    } finally { observation.dispose(); }
}

/** Exact-address readers need the same admitted configuration as catalog reads. */
export async function readTriageAccountDataSourceOptionsV1(context: SourceReadContext): Promise<AccountDataSourceReadOptionsV1> {
    const sources = await readTriageAdmittedSourceIndexV1(context);
    return { signal: context.signal, accountDataSources: readAccountDataSourceRecordsV1(sources) };
}
