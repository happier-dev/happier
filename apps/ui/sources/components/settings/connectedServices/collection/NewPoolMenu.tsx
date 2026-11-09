import * as React from 'react';

import { type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { CollectionAddMenu } from '@/components/ui/lists/collection/CollectionAddMenu';
import { t } from '@/text';

import { ConnectedServiceMark } from '../ConnectedServiceMark';
import type { ConnectedServicesIndexSheet } from '../model/buildConnectedServicesIndexModel';
import { buildConnectedServicesPoolChoices } from './connectedServicesAddChoices';
import { AddChoiceCount } from './ConnectedServicesAddMenu';
export { selectNewPoolServices } from '../setup/buildConnectedServiceSetupCatalog';

/**
 * "New pool" (the rail's Pools "+", the index's Pools action): the collection's add menu filtered to the services
 * that can hold a pool. Pools belong to one service, so with several services the trigger opens the menu of them;
 * with one it starts that service's pool draft at once.
 */
export const NewPoolMenu = React.memo(function NewPoolMenu(props: Readonly<{
    services: readonly ConnectedServicesIndexSheet[];
    onCreate: (sheet: ConnectedServicesIndexSheet) => void;
    renderTrigger: (onPress: () => void) => React.ReactElement;
    testID?: string;
}>) {
    const { services, onCreate } = props;
    const items = React.useMemo((): ReadonlyArray<DropdownMenuItem> => buildConnectedServicesPoolChoices(services).map((choice, index) => ({
        id: services[index]!.serviceKey,
        title: t('connectedServicesCollection.newPoolDraft', { service: choice.title }),
        subtitle: choice.purpose ?? undefined,
        icon: <ConnectedServiceMark legacyServiceId={services[index]!.legacyServiceId} pluginId={services[index]!.service.pluginId} size="inline" />,
        rightElement: choice.addedCount ? <AddChoiceCount count={choice.addedCount} /> : undefined,
    })), [services]);
    if (services.length === 0) return null;
    if (services.length === 1) return props.renderTrigger(() => onCreate(services[0]!));
    return (
        <CollectionAddMenu
            testID={props.testID ?? 'connected-services-new-pool-menu'}
            items={items}
            label={t('connectedServicesCollection.newPool')}
            onSelect={(serviceKey) => {
                const sheet = services.find((candidate) => candidate.serviceKey === serviceKey);
                if (sheet) onCreate(sheet);
            }}
            showCategoryTitles={false}
            renderTrigger={props.renderTrigger}
        />
    );
});
