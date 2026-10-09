import * as React from 'react';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { Icon } from '@/components/ui/icons/Icon';
import { getPreferredLanguage } from '@/text';
import { resolvePluginContributedActionIconName } from '@/components/plugins/actions/pluginContributedActionPresentation';
import { launchPluginSurfaceAction } from '@/components/plugins/surfaces/launchPluginSurfaceAction';
import { createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import type { ManagedPrerequisiteV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

type Provisioner = MachineProvisionersListResultV1['provisioners'][number];
function provisionerMark(provisioner?: Provisioner) {
    return <Icon name={resolvePluginContributedActionIconName(provisioner?.descriptor.icon)} size={28} />;
}

/** Catalog declarations own display identity; the selected controller's admitted bundles own translation. */
export function useManagedProvisionerPresentation(input: Readonly<{
    serverId: string; controller?: ManagedControllerV1;
    provisioner?: MachineProvisionersListResultV1['provisioners'][number];
}>) {
    const projection = useDaemonMergedProjectionInputs({ serverId: input.serverId, machineId: input.controller?.machineId, enabled: !!input.controller });
    const uiProjection = React.useMemo(() => normalizePluginUiProjection(projection.inputs?.pluginProjectionV2 ?? null), [projection.inputs?.pluginProjectionV2]);
    const locale = getPreferredLanguage();
    const localized = React.useMemo(() => createPluginLocalizedTextResolver({
        projection: uiProjection,
        locale,
    }), [uiProjection, locale]);
    const currentController = React.useRef(input.controller);
    currentController.current = input.controller;
    const repair = async (action: NonNullable<ManagedPrerequisiteV1['repairAction']>, binding: ServerCredentialAccountScopeBinding,
        signal?: AbortSignal) => {
        const controller = input.controller;
        if (!controller || !binding.isCurrent() || projection.phase !== 'ready') return { ok: false as const, code: 'unavailable', reason: 'controller_unavailable' };
        const result = await launchPluginSurfaceAction({ action: action.action, input: action.input,
            contributedAction: { machineId: controller.machineId, serverId: input.serverId, accountLifetime: binding },
            pluginUiProjection: uiProjection, resolveContributedAction: createPluginUiProjectedActionResolver(uiProjection.actionsById),
            ...(signal ? { signal } : {}),
            isCurrent: () => binding.isCurrent() && currentController.current?.machineId === controller.machineId
                && currentController.current?.installationId === controller.installationId,
        });
        return result.outcome;
    };
    return { localized, title: input.provisioner ? localized(input.provisioner.contribution.pluginId, input.provisioner.descriptor.title) : null,
        mark: provisionerMark(input.provisioner), markFor: provisionerMark,
        projection: uiProjection, projectionReady: projection.phase === 'ready', repair };
}
