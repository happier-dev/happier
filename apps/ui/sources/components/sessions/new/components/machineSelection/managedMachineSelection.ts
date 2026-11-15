import type { ReactNode } from 'react';
import type { ManagedCreationSelectionV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { hasOpenedManagedMachinePresetCreationV1, type OpenedManagedMachinePresetCreationV1, type OpenedManagedMachinePresetV1, type ManagedMachinePresetListEntryV1 } from '@/sync/ops/machines/machinePresetCollectionClient';

import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';
import type { resolveMachineDestinationPurposeEligibility } from './buildMachineDestinationModel';
import { supportedMachineRetentionEffectsV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';

export {
    createManagedMachineSelectionDraft,
    ManagedMachineSelectionDraftSchema,
    ManagedMachineSelectionDraftReadSchema,
    type ManagedMachineSelectionDraft,
} from '@/sync/domains/state/newSessionManagedMachineDraft';

/** A reviewed receipt may continue through the composer's ordinary creation owner. */
export type ManagedMachineUseOptions = Readonly<{ send?: boolean; create?: boolean }>;
export type ManagedMachineUse = (draft: ManagedMachineSelectionDraft, options?: ManagedMachineUseOptions) => void;

/** Preset offers are presentation, never enrolled Machines or published Runner artifacts. */
export type ManagedMachineSelectionOffer = Readonly<{
    id: string;
    homeId: string;
    /** Stable preset identity; revision is resolved by the existing current offer/configurator. */
    presetId?: string;
    /** A saved preset, or the one-off configuration entry. */
    kind?: 'preset' | 'one-off';
    title: string;
    /** What it makes and its Keep it rule (lab m-pick: "CX32 · Falkenstein · Until I delete it"). */
    subtitle?: string;
    /** A preset's provider mark; the one-off entry has none. */
    mark?: ReactNode;
    /** The right-hand cost column ("No bill · Runs on devbox", a returned price); nothing when unpriced. */
    cost?: ReactNode;
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

/** Live controller admission, never stored with a launch snapshot or paid acquisition. */
export type ManagedMachineArchiveChoiceAvailability = Readonly<{
    controllerMachineId?: string;
    controllerName?: string;
    custodian?: NonNullable<Machine['access']>['custodian'];
    custodianAccountId?: string;
    supportedEffects: readonly ManagedMachineSelectionDraft['archiveEffect'][];
    reason?: Extract<ReturnType<typeof resolveMachineDestinationPurposeEligibility>, { eligible: false }>['reason'];
    nativeUnsupportedEffects: readonly ('stop' | 'delete')[];
}>;

/** The reviewed creation chooses retention; it grants no ordinary controller access. */
export function resolveManagedMachineArchiveChoiceAvailability(input: Readonly<{
    draft: ManagedMachineSelectionDraft;
    controller?: Machine;
    /** The admitted managed row pins the same custodian as its controller. */
    controllerOwnership?: 'owned' | 'shared';
    custodianAccountId?: string;
}>): ManagedMachineArchiveChoiceAvailability {
    const pair = input.draft.receipt.controller;
    const controllerMachineId = pair?.machineId;
    const controller = pair && input.controller?.id === pair.machineId
        && input.controller.installationId === pair.installationId ? input.controller : undefined;
    const custodianAccountId = controller?.access?.custodian.accountId ?? input.custodianAccountId;
    const eligibility = pair && (controller || input.controllerOwnership)
        ? { eligible: true as const }
        : { eligible: false as const, reason: 'access_unavailable' as const };
    const nativeEffects = supportedMachineRetentionEffectsV1(input.draft.receipt.retentionCapabilities.supportedIntents);
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

/** Current-Home presets open the shared review; no offer admits native effects. */
export function buildManagedMachineSelectionOffers(params: Readonly<{
    homeId: string;
    presets: readonly ManagedMachinePresetListEntryV1[];
    oneOffTitle: string;
    oneOffSubtitle?: string;
    describeOffer?: (preset: OpenedManagedMachinePresetV1 & OpenedManagedMachinePresetCreationV1) => string | undefined;
    markFor?: (preset: OpenedManagedMachinePresetV1 & OpenedManagedMachinePresetCreationV1) => ReactNode;
    costFor?: (preset: OpenedManagedMachinePresetV1 & OpenedManagedMachinePresetCreationV1) => ReactNode;
    onConfigure: (preset: (OpenedManagedMachinePresetV1 & OpenedManagedMachinePresetCreationV1) | null) => void;
}>): readonly ManagedMachineSelectionOffer[] {
    return [...params.presets.filter((preset): preset is OpenedManagedMachinePresetV1 & OpenedManagedMachinePresetCreationV1 =>
        preset.homeId === params.homeId && preset.archivedAt === undefined && hasOpenedManagedMachinePresetCreationV1(preset)).map(preset => ({
        id: managedMachineSelectionOptionId({ kind: 'preset', homeId: preset.homeId, id: preset.id, revision: preset.revision }),
        homeId: preset.homeId,
        presetId: preset.id,
        kind: 'preset' as const,
        title: preset.name,
        subtitle: params.describeOffer?.(preset),
        ...(params.markFor ? { mark: params.markFor(preset) } : {}),
        ...(params.costFor ? { cost: params.costFor(preset) } : {}),
        onSelect: () => params.onConfigure(preset),
    })), {
        id: `managed-machine:${params.homeId}:one-off`, homeId: params.homeId, kind: 'one-off' as const,
        title: params.oneOffTitle, subtitle: params.oneOffSubtitle,
        onSelect: () => params.onConfigure(null),
    }];
}
