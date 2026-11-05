import type { ManagedResourceDependencyV1, ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { BUNDLED_MACHINE_PROVISIONER_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { Modal, type IModal } from '@/modal';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { t } from '@/text';

import { describeManagedLifecycleState, type ManagedLifecycleState } from './managedLifecyclePresentation';

/** What the person knows the resource as: its provider and kind ("Hetzner VM"), from the provisioner's own declaration. */
function managedResourceName(resource: ManagedResourceDependencyV1): string {
    const declaration = BUNDLED_MACHINE_PROVISIONER_DECLARATIONS[buildQualifiedPluginContributionKey(resource.provider)];
    if (!declaration) return t('common.machine');
    const localized = createPluginLocalizedTextResolver({ projection: null });
    const provider = localized(declaration.contribution.pluginId, declaration.descriptor.title);
    const kind = declaration.descriptor.kindTitle ? localized(declaration.contribution.pluginId, declaration.descriptor.kindTitle) : null;
    return kind ? t('managedMachines.detail.kindFact', { provider, kind }) : provider;
}

/** The review's recovery facts in the lifecycle vocabulary the machine's own page uses; null when nothing more is known. */
function managedResourceState(resource: ManagedResourceDependencyV1, name: string): ManagedLifecycleState | null {
    if (resource.allocation === 'confirmed-absent') return { kind: 'absent' };
    if (resource.cleanup) return resource.cleanup.disposition === 'pending' && resource.cleanup.reason === 'creation_canceled'
        ? { kind: 'creationCanceledCleanup' } : { kind: 'cleanupUnknown' };
    if (resource.allocation === 'may-exist') return { kind: 'mayExist', name };
    if (resource.observation?.availability === 'unavailable') return { kind: 'observationUnavailable' };
    return null;
}

/** One line per resource: its name, then where it stands. */
export function describeManagedRemovalResource(resource: ManagedResourceDependencyV1): string {
    const name = managedResourceName(resource);
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
    const dispositions = resources.map((resource): ManagedResourceDispositionV1 => ({
        managedId: resource.managedId,
        expectedIntentRevision: resource.intentRevision,
        expectedAllocation: resource.allocation,
        ...(resource.resource ? { expectedResource: resource.resource } : {}),
        ...(resource.nativeOperationRef ? { expectedNativeOperationRef: resource.nativeOperationRef } : {}),
        ...(resource.recovery ? { expectedRecovery: resource.recovery } : {}),
        responsibility: 'manual',
    }));
    const confirmed = options?.confirmationRequired === false || await modal.confirm(
        t('managedCleanup.reviewTitle'),
        undefined,
        {
            messageParagraphs: [
                { text: t('managedCleanup.removalReview') },
                ...resources.map(resource => ({ text: describeManagedRemovalResource(resource) })),
            ],
            confirmText: t('managedCleanup.acceptManual'),
            cancelText: t('common.cancel'),
            destructive: true,
        },
    );
    return confirmed ? dispositions : null;
}
