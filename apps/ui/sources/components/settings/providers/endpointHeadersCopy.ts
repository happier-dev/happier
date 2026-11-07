import type { EndpointHeadersEditorCopy, EndpointHeadersLayer } from '@happier-dev/plugin-ui';

import { t } from '@/text';

const SET_LABEL = {
    draft: 'settingsProvidersCollection.headersChanged',
    account: 'settingsProvidersCollection.headersSetAccount',
    machine: 'settingsProvidersCollection.headersSetMachine',
} as const;

/**
 * Happier's localized words for the shared public-header editor at one layer. A draft and every-machine
 * layer inherit the provider's defaults; a machine layer inherits what every machine uses.
 */
export function endpointHeadersCopy(layer: EndpointHeadersLayer): EndpointHeadersEditorCopy {
    const fromProvider = layer !== 'machine';
    return {
        title: t(layer === 'machine'
            ? 'settingsProvidersCollection.headersMachineTitle'
            : 'settingsProvidersCollection.headersTitle'),
        inherited: t(fromProvider
            ? 'settingsProvidersCollection.headersFromProvider'
            : 'settingsProvidersCollection.headersFromAccount'),
        set: t(SET_LABEL[layer]),
        required: t('settingsProvidersCollection.headersRequired'),
        changedCount: (count) => t('settingsProvidersCollection.headersChangedCount', { count }),
        needs: (names) => t('settingsProvidersCollection.headersNeeds', { names }),
        reset: t('settingsProvidersCollection.headersReset'),
        resetDescription: t(fromProvider
            ? 'settingsProvidersCollection.headersResetToProvider'
            : 'settingsProvidersCollection.headersResetToAccount'),
    };
}
