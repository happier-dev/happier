import type { ProviderDiscoveryCandidateV1 } from '@happier-dev/protocol/providers/detection/v1';
import type { ProviderDeclarationDetail } from '@/providers/catalog/providerDeclarationDetail';
import { presentProviderDeclarationModels } from '@/providers/catalog/providerDeclarationModelPresentation';
import { PROVIDER_CONNECTION_STATUS_KEY } from './presentation';
import { t } from '@/text';

/** Listener detection identifies a candidate; it does not establish endpoint or model availability. */
export function presentDetectedProvider(candidate: ProviderDiscoveryCandidateV1, machineName: string,
    models?: ProviderDeclarationDetail['models']): Readonly<{
        name: string;
        where: string;
        availability: string;
        models: ReturnType<typeof presentProviderDeclarationModels> | null;
    }> {
    return {
        name: candidate.providerName,
        where: t('settingsProvidersCollection.onMachine', { machine: machineName }),
        availability: t(PROVIDER_CONNECTION_STATUS_KEY.notChecked),
        models: models ? presentProviderDeclarationModels(candidate.providerName, models) : null,
    };
}
