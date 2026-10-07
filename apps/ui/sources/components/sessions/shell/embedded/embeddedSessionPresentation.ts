import type * as React from 'react';
import { resolveEffectiveApiTokenModelRefV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { serializeModelVisibilityRefV1, type ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import type { ComposerInputLockSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';

import type { PermissionMode } from '@/constants/PermissionModes';
import type { TranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';

/**
 * The embedded presentation of the one Session renderer (`SessionView`).
 *
 * It is the single owner of every choice an embedded mount makes — plugin session parts, the embed
 * route and the peek (`SessionInPane`) all pass their needs as options of this arm rather than as
 * flags of their own. Every option narrows; none adds authority, which stays with `Session.access`
 * and, for embeds, the credential grant behind it (`modelSelectionGranted` carries that grant's
 * independent model decision).
 */
export type SessionViewEmbeddedPresentation = Readonly<{
    kind: 'embedded';
    /** `'none'` is a read-only view: no composer, prompts not actionable here. */
    composer: 'auto' | 'none';
    /** Default `'minimal'`. The trusted app peek retains the Session's existing goal/MCP/plugin controls. */
    composerControls?: 'minimal' | 'session';
    /** Retains the input and its edits while authenticated submission reconnects. */
    composerInputLocked?: boolean;
    /** Default `true`. `false` removes the attachment affordance; it never adds one. */
    attachments?: boolean;
    /** Default `'app'`. A frame selects `'none'` to hide full-app route links. */
    navigation?: 'app' | 'none';
    /** Default `false`. Shows the Session's existing model picker where its own authority allows. */
    modelPicker?: boolean;
    /**
     * Default `false`. The credential grants `session.model.set` on its own (an embed's "Change model"
     * without Send): the shown picker is admitted on that grant instead of on text submission, in a
     * controls-only composer when the Session's own access cannot send. The server rechecks the exact
     * Action. It never adds Send or any other capability.
     */
    modelSelectionGranted?: boolean;
    /** Default `null` (no extra narrowing). Narrows the picker's options; never adds any. */
    allowedModels?: readonly ProviderBoundModelRef[] | null;
    /** Default `null`: permission mode is a label. With two or more modes, only those are offered. */
    permissionModePicker?: readonly PermissionMode[] | null;
    /** Which reason a non-actionable prompt gives. Default `'openSession'`. */
    readOnlyNotice?: 'openSession' | 'readOnly';
    /** One quiet line under the composer, saying where replies go (the peek). */
    repliesBanner?: React.ReactNode;
}>;

export type SessionViewPresentation =
    | Readonly<{ kind: 'primary' }>
    | SessionViewEmbeddedPresentation;

export const PRIMARY_SESSION_VIEW_PRESENTATION: SessionViewPresentation = Object.freeze({ kind: 'primary' });

export function narrowEmbeddedComposerInputLock(
    inputLock: ComposerInputLockSnapshotV1 | null,
    presentation: SessionViewEmbeddedPresentation | null,
    reason: string,
): ComposerInputLockSnapshotV1 | null {
    return inputLock ?? (presentation?.composerInputLocked ? { mode: 'submit', reasons: [reason] } : null);
}

export function readEmbeddedSessionPresentation(
    presentation: SessionViewPresentation | null | undefined,
): SessionViewEmbeddedPresentation | null {
    return presentation?.kind === 'embedded' ? presentation : null;
}

/**
 * The composer affordances an embedded presentation allows, derived once for every composer that
 * renders it — the embedded Session's own and the Settings embed preview's sample composer. The
 * embedded arm never mounts voice; the engine picker shows only when the presentation offers the
 * model picker; `attachments: false` removes the attach affordance.
 */
export function resolveEmbeddedComposerControls(
    presentation: SessionViewEmbeddedPresentation | null,
): Readonly<{ voiceAffordance: 'none'; engineControls: 'auto' | 'none'; attachments: boolean }> | null {
    if (!presentation) return null;
    return {
        voiceAffordance: 'none',
        engineControls: presentation.modelPicker === true ? 'auto' : 'none',
        attachments: presentation.attachments !== false,
    };
}

/**
 * The embedded arm's one interaction narrowing: the minimum of the Session's own access and the
 * arm's read-only choice. It is applied once, where `SessionView` derives its interaction; no row
 * re-decides it. Composer targeting never narrows interaction.
 */
export function narrowTranscriptInteractionForPresentation(
    interaction: TranscriptInteraction,
    presentation: SessionViewEmbeddedPresentation | null,
): TranscriptInteraction {
    if (!presentation) return interaction;
    const readOnly = presentation.composer === 'none';
    const canSendMessages = interaction.canSendMessages && !readOnly && !presentation.composerInputLocked;
    const canApprovePermissions = interaction.canApprovePermissions && !readOnly;
    if (canSendMessages && canApprovePermissions) return interaction;
    // An inactive Session keeps its own reason: nothing can be answered anywhere, so pointing the
    // viewer at the full Session would promise an action that does not exist.
    const permissionDisabledReason = interaction.permissionDisabledReason === 'inactive'
        ? 'inactive'
        : presentation.readOnlyNotice === 'readOnly'
            ? 'readOnly'
            : 'openSession';
    return {
        ...interaction,
        canSendMessages,
        canApprovePermissions,
        canFork: canSendMessages && interaction.canFork === true,
        permissionDisabledReason,
    };
}

/**
 * The embedded arm's `allowedModels` applied to the existing model picker's inputs: every model of
 * the Session's agent outside the list becomes a model hide key through the visibility owner the
 * picker already applies (`serializeModelVisibilityRefV1`), and connection rows outside the list
 * are dropped by the same key. `null` (or no list) means no extra narrowing. Nothing is added.
 */
export function narrowSessionModelPickerToAllowedModels<
    TGroup extends Readonly<{ rows: readonly Readonly<{ ref: ProviderBoundModelRef }>[] }>,
>(input: Readonly<{
    allowedModels: readonly ProviderBoundModelRef[] | null | undefined;
    agentTargetKey: string | null | undefined;
    nativeModels: readonly Readonly<{ value: string }>[];
    providerGroups: readonly TGroup[];
    hiddenNativeModelKeys: ReadonlySet<string>;
}>): Readonly<{
    hiddenNativeModelKeys: ReadonlySet<string>;
    providerGroups: readonly TGroup[];
    allowAutomatic: false;
    canEnterCustomValue: false;
}> | null {
    if (!input.allowedModels || !input.agentTargetKey) return null;
    const allowed = new Set(input.allowedModels.map(toModelVisibilityKey));
    const hiddenNativeModelKeys = new Set(input.hiddenNativeModelKeys);
    for (const model of input.nativeModels) {
        if (model.value === 'default') continue;
        const key = toModelVisibilityKey({
            agentTargetKey: input.agentTargetKey,
            providerConnectionId: null,
            modelId: model.value,
        });
        if (!allowed.has(key)) hiddenNativeModelKeys.add(key);
    }
    const providerGroups = input.providerGroups.map((group) => {
        const rows = group.rows.filter((row) => allowed.has(toModelVisibilityKey(row.ref)));
        return rows.length === group.rows.length ? group : { ...group, rows };
    });
    return { hiddenNativeModelKeys, providerGroups, allowAutomatic: false, canEnterCustomValue: false };
}

export function toModelVisibilityKey(ref: ProviderBoundModelRef): string {
    return serializeModelVisibilityRefV1({
        scope: 'agent',
        agentTargetKey: ref.agentTargetKey,
        providerConnectionId: ref.providerConnectionId,
        modelId: ref.modelId,
    });
}

/**
 * The model a model-restricted arm's next message runs on: the Session's own selection when the list
 * allows it, else the first allowed model (plan 04 §4.6). The protocol decides membership
 * (`resolveEffectiveApiTokenModelRefV1`); the outgoing record applies the same rule when sending.
 */
export function readEffectiveAllowedModelRef(
    allowedModels: readonly ProviderBoundModelRef[],
    selected: ProviderBoundModelRef | null | undefined,
    agentTargetKey?: string,
): ProviderBoundModelRef | null {
    const effective = resolveEffectiveApiTokenModelRefV1({ models: [...allowedModels] }, selected ?? 'automatic', agentTargetKey);
    return effective === 'automatic' ? selected ?? null : effective;
}
