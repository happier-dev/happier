import * as React from 'react';
import type { PluginProjectionV2 } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { t } from '@/text';

import {
    createPluginAccountReleaseSelectionController,
    type PluginAccountReleaseSelectionController,
    type PluginAccountReleaseSelectionControllerResult,
} from './pluginAccountReleaseSelectionController';

type ControllerLifetime = {
    controller: PluginAccountReleaseSelectionController;
    current: boolean;
};

function showResult(result: PluginAccountReleaseSelectionControllerResult): void {
    switch (result.kind) {
        case 'selected':
            Modal.alert(
                t('common.success'),
                t('settingsPlugins.accountReleaseSelection.selectedBody'),
            );
            return;
        case 'conflict':
            Modal.alert(
                t('settingsPlugins.accountReleaseSelection.conflictTitle'),
                t('settingsPlugins.accountReleaseSelection.conflictBody'),
            );
            return;
        case 'rejected':
            Modal.alert(
                t('settingsPlugins.accountReleaseSelection.rejectedTitle'),
                t('settingsPlugins.accountReleaseSelection.rejectedBody'),
            );
            return;
        case 'unavailable':
            Modal.alert(
                t('settingsPlugins.accountReleaseSelection.unavailableTitle'),
                t('settingsPlugins.accountReleaseSelection.unavailableBody'),
            );
            return;
        case 'cancelled':
            return;
    }
}

/**
 * Present-user Account release action. It intentionally has no machine
 * installation/trust authority: the controller asks Availability for the
 * exact release, and only its typed response may trigger preparation.
 */
export function PluginAccountReleaseSelectionSection(props: Readonly<{
    pluginId: string;
    version: string;
    reader: PluginAccountAvailabilityReader | null;
    /** The live raw daemon projection, if this Account action can use it. */
    projection: PluginProjectionV2 | null;
    daemon: Readonly<{
        serverId: string | null;
        serverIdentityId: string | null;
        machineId: string | null;
    }>;
    testID: string;
}>): React.ReactElement {
    const [pending, setPending] = React.useState(false);
    const controllerLifetimeRef = React.useRef<ControllerLifetime | null>(null);

    React.useEffect(() => {
        const lifetime: ControllerLifetime = {
            controller: createPluginAccountReleaseSelectionController(),
            current: true,
        };
        controllerLifetimeRef.current = lifetime;
        return () => {
            lifetime.current = false;
            if (controllerLifetimeRef.current === lifetime) controllerLifetimeRef.current = null;
            lifetime.controller.retire();
        };
    }, []);

    const selectRelease = React.useCallback(() => {
        const lifetime = controllerLifetimeRef.current;
        if (!lifetime || pending || lifetime.controller.isPending()) return;
        setPending(true);
        void (async () => {
            try {
                const result = await lifetime.controller.select({
                    pluginId: props.pluginId,
                    version: props.version,
                    reader: props.reader,
                    projection: props.projection,
                    daemon: props.daemon,
                    isCurrent: () => lifetime.current && controllerLifetimeRef.current === lifetime,
                });
                if (lifetime.current && controllerLifetimeRef.current === lifetime) {
                    showResult(result);
                }
            } catch {
                if (lifetime.current && controllerLifetimeRef.current === lifetime) {
                    showResult(Object.freeze({ kind: 'unavailable' as const, code: 'target_release_unavailable' as const }));
                }
            } finally {
                if (lifetime.current && controllerLifetimeRef.current === lifetime) setPending(false);
            }
        })();
    }, [pending, props.daemon, props.pluginId, props.projection, props.reader, props.version]);

    return (
        <ItemGroup
            title={t('settingsPlugins.accountReleaseSelection.groupTitle')}
            footer={t('settingsPlugins.accountReleaseSelection.groupFooter')}
        >
            <Item
                testID={props.testID}
                title={t('settingsPlugins.accountReleaseSelection.entryTitle')}
                subtitle={t('settingsPlugins.accountReleaseSelection.entrySubtitle', { version: props.version })}
                onPress={selectRelease}
                disabled={pending}
                loading={pending}
                showChevron={false}
            />
        </ItemGroup>
    );
}
