import type { ManagedCreationSelectionV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import { resolveMachineDestinationPurposeEligibility } from './buildMachineDestinationModel';

export {
    createManagedMachineSelectionDraft,
    ManagedMachineSelectionDraftSchema,
    ManagedMachineSelectionDraftReadSchema,
    type ManagedMachineSelectionDraft,
} from '@/sync/domains/state/newSessionManagedMachineDraft';

/** Recipe offers are presentation, never enrolled Machines or published Runner artifacts. */
export type ManagedMachineSelectionOffer = Readonly<{
    id: string;
    homeId: string;
    /** A saved preset, or the one-off configuration entry. */
    kind?: 'preset' | 'one-off';
    title: string;
    /** Controller/Keep facts only; prices belong to the shared reviewed receipt. */
    subtitle?: string;
    draft?: ManagedMachineSelectionDraft;
    disabled?: boolean;
    unavailableText?: string;
    /** Opens shared configuration for an offer which has not yet been reviewed. */
    onSelect?: () => void;
}>;

export type ManagedMachineDestinationProjection = Readonly<{
    state: 'pending' | 'available' | 'unavailable';
    rowCount: number;
}>;

/** Live controller admission, never stored with a recipe or paid acquisition. */
export type ManagedMachineArchiveChoiceAvailability = Readonly<{
    controllerMachineId: string;
    controllerName?: string;
    custodian?: NonNullable<Machine['access']>['custodian'];
    custodianAccountId?: string;
    supportedEffects: readonly ManagedMachineSelectionDraft['archiveEffect'][];
    reason?: Extract<ReturnType<typeof resolveMachineDestinationPurposeEligibility>, { eligible: false }>['reason'];
    nativeUnsupportedEffects: readonly ('stop' | 'delete')[];
}>;

/** Scope rules execute on the controller and share the ordinary trigger-purpose decision. */
export function resolveManagedMachineArchiveChoiceAvailability(input: Readonly<{
    draft: ManagedMachineSelectionDraft;
    controller?: Machine;
    /** The admitted managed row pins the same custodian as its controller. */
    controllerOwnership?: 'owned' | 'shared';
    custodianAccountId?: string;
}>): ManagedMachineArchiveChoiceAvailability {
    const controllerMachineId = input.draft.receipt.controller.machineId;
    const controller = input.controller?.id === controllerMachineId ? input.controller : undefined;
    const custodianAccountId = controller?.access?.custodian.accountId ?? input.custodianAccountId;
    const eligibility = controller || input.controllerOwnership
        ? resolveMachineDestinationPurposeEligibility('trigger', input.controllerOwnership ? { ownership: input.controllerOwnership } : undefined, controller)
        : { eligible: false as const, reason: 'access_unavailable' as const };
    const nativeEffects = (['stop', 'delete'] as const).filter(effect => input.draft.receipt.retentionCapabilities.supportedIntents.includes(effect));
    return {
        controllerMachineId,
        ...(controller ? { controllerName: getMachineDisplayName(controller) } : {}),
        ...(controller?.access ? { custodian: controller.access.custodian } : {}),
        ...(custodianAccountId ? { custodianAccountId } : {}),
        supportedEffects: eligibility.eligible ? ['keep', ...nativeEffects] : ['keep'],
        ...(!eligibility.eligible ? { reason: eligibility.reason } : {}),
        nativeUnsupportedEffects: (['stop', 'delete'] as const).filter(effect => !nativeEffects.includes(effect)),
    };
}

export function managedMachineSelectionOptionId(selection: ManagedCreationSelectionV1): string {
    return selection.kind === 'preset'
        ? `managed-machine:${selection.homeId}:preset:${selection.id}:${selection.revision}`
        : `managed-machine:${selection.homeId}:one-off`;
}

/** Current-Home recipes open the shared review; no offer admits native effects. */
export function buildManagedMachineSelectionOffers(params: Readonly<{
    homeId: string;
    presets: readonly ManagedMachinePresetV1[];
    oneOffTitle: string;
    oneOffSubtitle?: string;
    describeController?: (preset: ManagedMachinePresetV1) => string | undefined;
    onConfigure: (preset: ManagedMachinePresetV1 | null) => void;
}>): readonly ManagedMachineSelectionOffer[] {
    return [...params.presets.filter(preset => preset.homeId === params.homeId && preset.archivedAt === undefined).map(preset => ({
        id: managedMachineSelectionOptionId({ kind: 'preset', homeId: preset.homeId, id: preset.id, revision: preset.revision }),
        homeId: preset.homeId,
        kind: 'preset' as const,
        title: preset.name,
        subtitle: params.describeController?.(preset),
        onSelect: () => params.onConfigure(preset),
    })), {
        id: `managed-machine:${params.homeId}:one-off`, homeId: params.homeId, kind: 'one-off' as const,
        title: params.oneOffTitle, subtitle: params.oneOffSubtitle,
        onSelect: () => params.onConfigure(null),
    }];
}
