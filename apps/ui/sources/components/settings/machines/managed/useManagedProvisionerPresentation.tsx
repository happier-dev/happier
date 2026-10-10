import * as React from 'react';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginProjectionInstalledPackageV2 } from '@happier-dev/protocol';
import { Icon } from '@/components/ui/icons/Icon';
import { InstalledPluginBrandMark } from '@/components/plugins/shared/InstalledPluginBrandMark';
import { useServerInstalledPluginBrand } from '@/components/settings/plugins/PluginMark';
import { getPreferredLanguage } from '@/text';
import { resolvePluginContributedActionIconName } from '@/components/plugins/actions/pluginContributedActionPresentation';
import { launchPluginSurfaceAction } from '@/components/plugins/surfaces/launchPluginSurfaceAction';
import { createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import type { ManagedPrerequisiteV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

type Provisioner = MachineProvisionersListResultV1['provisioners'][number];
type ProvisionerMarkProps = Readonly<{
    icon?: string;
    installedPackage?: PluginProjectionInstalledPackageV2 | null;
    machineId?: string;
    serverId: string;
}>;

/** The provisioner's identity: its package's contributed brand mark, else the glyph its descriptor names. */
function ManagedProvisionerMark(props: ProvisionerMarkProps) {
    if (props.installedPackage?.brand?.state === 'available' && props.machineId) return <ManagedProvisionerBrandMark {...props} />;
    return <ManagedProvisionerGlyph icon={props.icon} />;
}

function ManagedProvisionerBrandMark(props: ProvisionerMarkProps) {
    const brand = useServerInstalledPluginBrand(props);
    return brand?.bytes ? <InstalledPluginBrandMark brand={brand} externallyLabelled pixelSize={28} />
        : <ManagedProvisionerGlyph icon={props.icon} />;
}

function ManagedProvisionerGlyph(props: Readonly<{ icon?: string }>) {
    return <Icon name={resolvePluginContributedActionIconName(props.icon)} size={28} />;
}

/** Catalog declarations own display identity; the selected controller's admitted bundles own translation. */
export function useManagedProvisionerPresentation(input: Readonly<{
    serverId: string; controller?: ManagedControllerV1;
    provisioner?: MachineProvisionersListResultV1['provisioners'][number];
    provider?: Provisioner['contribution']; schemaVersion?: number;
}>) {
    const projection = useDaemonMergedProjectionInputs({ serverId: input.serverId, machineId: input.controller?.machineId, enabled: !!input.controller });
    const uiProjection = React.useMemo(() => normalizePluginUiProjection(projection.inputs?.pluginProjectionV2 ?? null), [projection.inputs?.pluginProjectionV2]);
    const locale = getPreferredLanguage();
    const projected = input.provider ? projection.inputs?.pluginProjectionV2?.familiesById.machineProvisioners?.entriesById[
        buildQualifiedPluginContributionKey(input.provider)] : undefined;
    const provisioner = input.provisioner ?? (projected && projected.definition.schemaVersion === input.schemaVersion
        ? { contribution: { pluginId: projected.pluginId, localId: projected.definition.id }, descriptor: projected.definition } : undefined);
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
    const installedPackages = projection.inputs?.pluginProjectionV2?.installedPackagesById;
    const markFor = (row?: Pick<Provisioner, 'contribution' | 'descriptor'>) => <ManagedProvisionerMark icon={row?.descriptor.icon}
        installedPackage={row ? installedPackages?.[row.contribution.pluginId] : null} machineId={input.controller?.machineId} serverId={input.serverId} />;
    return { localized, title: provisioner ? localized(provisioner.contribution.pluginId, provisioner.descriptor.title) : null,
        kindTitle: provisioner?.descriptor.kindTitle ? localized(provisioner.contribution.pluginId, provisioner.descriptor.kindTitle) : null,
        description: provisioner?.descriptor.description ? localized(provisioner.contribution.pluginId, provisioner.descriptor.description) : null,
        resourceIdPath: provisioner?.descriptor.resourceIdPath ?? null,
        mark: markFor(provisioner), markFor,
        projection: uiProjection, projectionReady: projection.phase === 'ready', repair };
}
