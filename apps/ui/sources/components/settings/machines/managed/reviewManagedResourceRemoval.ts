import { isManagedOpaquePresetResourceDependencyV1, type ManagedResourceDependencyV1, type ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { BUNDLED_MACHINE_PROVISIONER_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { Modal, type IModal } from '@/modal';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { storage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';
import { getSettledMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';

import { describeManagedLifecycleState, managedLifecycleActionLabel, type ManagedLifecycleState } from './managedLifecyclePresentation';
import { nativeIdentityLines } from './managedMachineDisplay';
import { managedConfirmedAbsenceState } from './managedCreationPresentation';

/** What the person knows the resource as: its provider and kind ("Hetzner VM"), from the provisioner's own declaration. */
function managedResourceProvider(resource: ManagedResourceDependencyV1): Readonly<{ provider: string; name: string }> | null {
    if (isManagedOpaquePresetResourceDependencyV1(resource)) return null;
    const declaration = BUNDLED_MACHINE_PROVISIONER_DECLARATIONS[buildQualifiedPluginContributionKey(resource.provider)];
    if (!declaration) return null;
    const localized = createPluginLocalizedTextResolver({ projection: null });
    const provider = localized(declaration.contribution.pluginId, declaration.descriptor.title);
    const kind = declaration.descriptor.kindTitle ? localized(declaration.contribution.pluginId, declaration.descriptor.kindTitle) : null;
    return { provider, name: kind ? t('managedMachines.detail.kindFact', { provider, kind }) : provider };
}

/** The machine it is managed from, by its settled name; left out when this device can't name it yet. */
function managedResourceControllerName(resource: ManagedResourceDependencyV1): string | null {
    const machineId = resource.controller?.machineId;
    if (!machineId) return null;
    for (const machines of Object.values(storage.getState().machineListByServerId ?? {})) {
        const machine = machines?.find(candidate => candidate.id === machineId);
        if (machine) return getSettledMachineDisplayName(machine);
    }
    return null;
}

/**
 * What tells this resource apart from another of the same provider, in the words its own page uses (lab m-life
 * recovery): the Happier tag or recovery reference, the native identity and the machine it is managed from.
 */
function managedResourceFacts(resource: ManagedResourceDependencyV1): string[] {
    const controller = managedResourceControllerName(resource);
    const native = isManagedOpaquePresetResourceDependencyV1(resource) ? null : resource;
    return [
        ...(native?.recovery ? [`${t(native.recovery.reference === resource.managedId
            ? 'managedMachines.detail.happierTag' : 'managedMachines.detail.recoveryReference')} ${native.recovery.reference}`] : []),
        ...(native?.resource ? nativeIdentityLines(native.resource.value) : []),
        ...(controller ? [`${t('managedMachines.config.managedFrom')} ${controller}`] : []),
    ];
}

/** The review's recovery facts in the lifecycle vocabulary the machine's own page uses; null when nothing more is known. */
function managedResourceState(resource: ManagedResourceDependencyV1, name: string): ManagedLifecycleState | null {
    if (resource.allocation === 'confirmed-absent') return isManagedOpaquePresetResourceDependencyV1(resource)
        ? { kind: 'absent' } : managedConfirmedAbsenceState(resource);
    if (resource.cleanup) return resource.cleanup.disposition === 'pending' && resource.cleanup.reason === 'creation_canceled'
        ? { kind: 'creationCanceledCleanup' } : { kind: 'cleanupUnknown' };
    if (resource.allocation === 'may-exist') return { kind: 'mayExist', name };
    if (resource.observation?.availability === 'unavailable') return { kind: 'observationUnavailable' };
    return null;
}

/** One line per resource: its name, then where it stands. */
export function describeManagedRemovalResource(resource: ManagedResourceDependencyV1): string {
    const name = managedResourceProvider(resource)?.name ?? t('common.machine');
    const state = managedResourceState(resource, name);
    // A may-exist line already names the resource; it is not said twice.
    if (state?.kind === 'mayExist') return describeManagedLifecycleState(state).line;
    return state ? `${name} · ${describeManagedLifecycleState(state).line}` : name;
}

/** Native owners supply non-secret recovery facts and validate these exact expectations on retry. */
export async function reviewManagedResourceRemoval(
    resources: readonly ManagedResourceDependencyV1[],
    modal: Pick<IModal, 'confirm'> = Modal,
    options?: Readonly<{ confirmationRequired: boolean }>,
): Promise<ManagedResourceDispositionV1[] | null> {
    const dispositions = resources.map((resource): ManagedResourceDispositionV1 => {
        const lifecycle = {
            managedId: resource.managedId,
            expectedIntentRevision: resource.intentRevision,
            expectedAllocation: resource.allocation,
            responsibility: 'manual' as const,
        };
        return isManagedOpaquePresetResourceDependencyV1(resource) ? { ...lifecycle, opaquePreset: true } : {
            ...lifecycle,
            ...(resource.resource ? { expectedResource: resource.resource } : {}),
            ...(resource.nativeOperationRef ? { expectedNativeOperationRef: resource.nativeOperationRef } : {}),
            ...(resource.recovery ? { expectedRecovery: resource.recovery } : {}),
        };
    });
    const confirmed = options?.confirmationRequired === false || await modal.confirm(
        t('managedCleanup.reviewTitle'),
        undefined,
        {
            messageParagraphs: [
                { text: t('managedCleanup.removalReview') },
                ...resources.flatMap(resource => {
                    const facts = managedResourceFacts(resource);
                    const consoleUrl = isManagedOpaquePresetResourceDependencyV1(resource) ? undefined : resource.recovery?.consoleUrl;
                    const link = consoleUrl ? { label: managedLifecycleActionLabel('openProvider', managedResourceProvider(resource)?.provider),
                        onPress: () => fireAndForget(openExternalUrl(consoleUrl), { tag: 'reviewManagedResourceRemoval.openConsole' }) } : undefined;
                    // The resource's line, then what tells it apart; its console link closes its own facts.
                    const lines = [describeManagedRemovalResource(resource), ...(facts.length > 0 ? [facts.join('\n')] : [])];
                    return lines.map((text, index) => ({ text, ...(link && index === lines.length - 1 ? { link } : {}) }));
                }),
            ],
            confirmText: t('managedCleanup.acceptManual'),
            cancelText: t('common.cancel'),
            destructive: true,
        },
    );
    return confirmed ? dispositions : null;
}
