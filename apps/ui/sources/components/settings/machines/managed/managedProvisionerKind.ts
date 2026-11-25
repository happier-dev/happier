import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ManagedAcquireInputV1Schema, resolveManagedAcquireReviewV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { formatManagedAcquireReviewLine, managedAcquireApprovalPresentation } from '@happier-dev/protocol/actions/specs/managedAcquireApproval';

import { BUNDLED_MACHINE_PROVISIONER_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { storage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';
import { getSettledMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

/** What the person knows a managed resource as: its provider and kind ("Lima VM"), from the provisioner's own declaration. */
export function describeManagedProvisionerKind(provider: PluginContributionIdentityV1): Readonly<{ provider: string; name: string }> | null {
    const declaration = BUNDLED_MACHINE_PROVISIONER_DECLARATIONS[buildQualifiedPluginContributionKey(provider)];
    if (!declaration) return null;
    const localized = createPluginLocalizedTextResolver({ projection: null });
    const title = localized(declaration.contribution.pluginId, declaration.descriptor.title);
    const kind = declaration.descriptor.kindTitle ? localized(declaration.contribution.pluginId, declaration.descriptor.kindTitle) : null;
    return { provider: title, name: kind ? t('managedMachines.detail.kindFact', { provider: title, kind }) : title };
}

/** A Machine by its settled name; null when this device can't name it yet. */
export function readSettledMachineName(machineId: string): string | null {
    for (const machines of Object.values(storage.getState().machineListByServerId ?? {})) {
        const machine = machines?.find(candidate => candidate.id === machineId);
        if (machine) return getSettledMachineDisplayName(machine);
    }
    return null;
}

/**
 * A managed Create's fact line as the person reads it: the kind in words and the machine that manages it ("Lima VM
 * on Studio Mac"), then the facts Protocol's line keeps. A kind this app can't name leaves the provider out rather
 * than showing its raw id. Null when the input is not a Create.
 */
export function describeManagedAcquireApprovalLine(actionArgs: unknown): string | null {
    const parsed = ManagedAcquireInputV1Schema.safeParse(actionArgs);
    if (!parsed.success) return null;
    const review = managedAcquireApprovalPresentation.projectInput(parsed.data);
    const { selection } = parsed.data;
    const kind = selection.kind === 'one-off' ? describeManagedProvisionerKind(selection.launch.provider)?.name ?? null : null;
    const controllerId = resolveManagedAcquireReviewV1(parsed.data).controller?.machineId;
    const machine = controllerId ? readSettledMachineName(controllerId) : null;
    const label = kind && machine ? t('managedMachines.detail.kindOnMachine', { kind, machine }) : kind;
    // A provisioner title the request reviewed already reads as words; only a raw fallback is dropped.
    const reviewedTitle = selection.kind === 'one-off' && review.provider !== selection.launch.provider.pluginId ? review.provider : null;
    return formatManagedAcquireReviewLine(review, label ?? reviewedTitle);
}
