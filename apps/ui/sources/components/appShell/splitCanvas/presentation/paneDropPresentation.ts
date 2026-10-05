import type { HappierReleaseGlyph, HappierReleaseOutcome } from '@happier-dev/plugin-ui/presentation';
import type { EntityDropAdmissionV1, EntityDropEffectV1, EntityDropPreviewV1, EntityDropReasonV1 } from '@happier-dev/protocol/plugins/ui';

import type { EntityDragDropSnapshot } from '@/components/ui/treeDragDrop/entityDragDropTypes';
import { t } from '@/text';

import type { SplitCanvasDropTarget } from '../model/splitCanvasTypes';

/**
 * The words of a pane drop (DnD lab C2/C2s): what releasing over a pane or its tab strip does, said
 * on the carried card. The workspace and the Session canvas decide (`resolveWorkspaceEntityDrop`,
 * `resolveSessionCanvasEntityDrop`); this is the one place both say it, so a pane never words the
 * same outcome two ways. Pane zones keep only geometry; the outcome lives on the card.
 */

type Placement = SplitCanvasDropTarget['placement'];
type PaneEffectKind = 'goTo' | 'open' | 'move';
type AllowedEffect = Extract<EntityDropAdmissionV1, { status: 'allowed' }>['effect'];
type PaneDropEffect = Omit<EntityDropEffectV1, 'preview'>;

/** Domain owners decide the effect and refusal code; presentation completes the portable contract. */
export type PaneDropAdmission =
    | Readonly<{ status: 'allowed'; effect: PaneDropEffect }>
    | Readonly<{ status: 'refused'; reason: Pick<EntityDropReasonV1, 'code'> }>;

const PANE_EFFECT_KINDS: Readonly<Record<string, PaneEffectKind>> = {
    'workspace.tabs.activate': 'goTo',
    'session.canvas.tabs.activate': 'goTo',
    'workspace.tabs.open': 'open',
    'session.canvas.tabs.open': 'open',
    'workspace.tabs.move': 'move',
    'workspace.tabs.reorder': 'move',
    'workspace.split': 'move',
    'session.canvas.tabs.move': 'move',
    'session.canvas.tabs.reorder': 'move',
};

/** A tab carried over its own pane: releasing leaves it where it is (lab C2s "Same pane, same place"). */
const ALREADY_HERE_CODES: ReadonlySet<string> = new Set([
    'already_here', 'workspace_tab_already_here',
    'workspace_tab_cannot_split_own_pane', 'canvas_tab_cannot_split_own_pane',
]);
const GONE_CODES: ReadonlySet<string> = new Set([
    'workspace_scope_unavailable', 'workspace_group_unavailable', 'workspace_tab_not_found',
    'canvas_scope_changed', 'canvas_leaf_not_found', 'canvas_tab_not_found',
    'target-retired', 'source-retired',
]);

const OPEN_MODES: Readonly<Record<string, Placement>> = {
    newTab: 'center', splitLeft: 'left', splitRight: 'right', splitUp: 'up', splitDown: 'down',
};

function inputRecord(effect: PaneDropEffect): Readonly<Record<string, unknown>> {
    const input = effect.input;
    return input && typeof input === 'object' && !Array.isArray(input) ? input as Readonly<Record<string, unknown>> : {};
}

function isPlacement(value: unknown): value is Placement {
    return value === 'center' || value === 'left' || value === 'right' || value === 'up' || value === 'down';
}

function paneEffectKind(effect: EntityDropEffectV1): PaneEffectKind | null {
    return PANE_EFFECT_KINDS[effect.actionId] ?? null;
}

/** Where the effect puts the item: a tab in the pane (`center`) or a new pane at an edge. */
function effectPlacement(effect: PaneDropEffect): Placement {
    const input = inputRecord(effect);
    if (isPlacement(input.placement)) return input.placement;
    if (effect.actionId === 'workspace.split' && isPlacement(input.direction)) return input.direction;
    if (typeof input.mode === 'string') return OPEN_MODES[input.mode] ?? 'center';
    return 'center';
}

function effectTabId(effect: PaneDropEffect): string | null {
    const tabId = inputRecord(effect).tabId;
    return typeof tabId === 'string' ? tabId : null;
}

function effectAnchored(effect: EntityDropEffectV1): boolean {
    return typeof inputRecord(effect).beforeTabId === 'string';
}

export type PaneDropScene = Readonly<{
    /** The pane under the pointer (its leaf id). */
    paneId: string;
    /** The open tab's name in that pane: what a new tab opens next to. */
    paneTitle: string | null;
    /** The tab a strip drop lands before; `null` is the end of the strip. Absent over a pane body. */
    beforeTabId?: string | null;
    /** The pointer is in an edge band of a pane too narrow to split, so its centre took the drop. */
    declinedSplit?: boolean;
    /** A pane that renders Sessions only (the Session canvas). */
    sessionsOnly?: boolean;
    /** Where an open tab lives and what it is called. */
    locateTab: (tabId: string) => Readonly<{ paneId: string; title: string }> | null;
}>;

function splitVerb(placement: Exclude<Placement, 'center'>): string {
    switch (placement) {
        case 'left': return t('entityDragDrop.pane.splitLeft');
        case 'right': return t('entityDragDrop.pane.splitRight');
        case 'up': return t('entityDragDrop.pane.splitUp');
        case 'down': return t('entityDragDrop.pane.splitDown');
    }
}

function describeAllowed(effect: Omit<AllowedEffect, 'preview'>, kind: PaneEffectKind, scene: PaneDropScene): EntityDropPreviewV1 {
    const paneTitle = scene.paneTitle;
    if (kind === 'goTo') {
        const tabId = effectTabId(effect);
        const located = tabId ? scene.locateTab(tabId) : null;
        const title = located?.title ?? scene.paneTitle ?? t('workspaceBar.tabsLabel');
        return {
            verb: t('entityDragDrop.pane.goTo', { target: title }),
            target: title,
            consequence: located?.paneId === scene.paneId
                ? t('entityDragDrop.pane.openInThisPane')
                : t('entityDragDrop.pane.openInAnotherPane'),
        };
    }
    const placement = effectPlacement(effect);
    if (placement !== 'center') {
        const verb = splitVerb(placement);
        return {
            verb,
            target: paneTitle ?? verb,
            ...(paneTitle ? { consequence: kind === 'open'
                ? t('entityDragDrop.pane.opensBeside', { target: paneTitle })
                : t('entityDragDrop.pane.movesBeside', { target: paneTitle }) } : {}),
        };
    }
    const anchorTitle = scene.beforeTabId ? scene.locateTab(scene.beforeTabId)?.title ?? null : null;
    if (anchorTitle) {
        return kind === 'open'
            ? { verb: t('entityDragDrop.pane.openBefore', { target: anchorTitle }), target: anchorTitle,
                consequence: t('entityDragDrop.pane.nothingCloses') }
            : { verb: t('entityDragDrop.pane.moveBefore', { target: anchorTitle }), target: anchorTitle,
                consequence: t('entityDragDrop.pane.placeOnly') };
    }
    const verb = kind === 'open' ? t('entityDragDrop.pane.openHere') : t('entityDragDrop.pane.moveHere');
    return {
        verb,
        target: paneTitle ?? verb,
        consequence: scene.declinedSplit
            ? t('entityDragDrop.pane.tooNarrow')
            : paneTitle ? t('entityDragDrop.pane.nextTo', { target: paneTitle }) : t('entityDragDrop.pane.nothingCloses'),
    };
}

function refusalMessage(code: string, scene: PaneDropScene): string {
    if (GONE_CODES.has(code)) return t('entityDragDrop.reasons.gone');
    switch (code) {
        case 'canvas_kind_unsupported': return scene.sessionsOnly ? t('entityDragDrop.pane.sessionsOnly') : t('entityDragDrop.reasons.generic');
        case 'session_workspace_unavailable': return t('entityDragDrop.pane.otherWorkspace');
        case 'admission-unavailable': return t('entityDragDrop.reasons.unavailable');
        default: return t('entityDragDrop.reasons.generic');
    }
}

function isPresentedAdmission(admission: PaneDropAdmission | EntityDropAdmissionV1): admission is EntityDropAdmissionV1 {
    return admission.status === 'allowed' ? 'preview' in admission.effect : 'message' in admission.reason;
}

/**
 * The pane owner's verdict, worded. An allowed effect keeps its Action and input and gains its
 * words; a refusal keeps its code and gains the reason a person can act on.
 */
export function presentPaneDropAdmission(admission: PaneDropAdmission | EntityDropAdmissionV1, scene: PaneDropScene): EntityDropAdmissionV1 {
    if (admission.status === 'refused') {
        const code = admission.reason.code;
        if (ALREADY_HERE_CODES.has(code)) {
            const verb = t('entityDragDrop.pane.alreadyHere');
            return { status: 'refused', reason: { code, message: t('entityDragDrop.pane.leaveIt') },
                preview: { verb, target: scene.paneTitle ?? verb } };
        }
        const verb = t('entityDragDrop.pane.cantOpenHere');
        return { status: 'refused', reason: { code, message: refusalMessage(code, scene) },
            preview: { verb, target: scene.paneTitle ?? verb } };
    }
    const kind = PANE_EFFECT_KINDS[admission.effect.actionId];
    if (!kind) {
        // Other owners may pass an already-presented effect through this composition seam.
        if (isPresentedAdmission(admission)) return admission;
        throw new TypeError(`Unsupported pane drop action: ${admission.effect.actionId}`);
    }
    return { status: 'allowed', effect: { ...admission.effect, preview: describeAllowed(admission.effect, kind, scene) } };
}

/** A chooser entry's name for one pane place ("Split right · Review #2481"). */
export function describePaneDropDestination(placement: Placement, paneTitle: string | null): string {
    const action = placement === 'center' ? t('entityDragDrop.pane.openHere') : splitVerb(placement);
    return paneTitle ? `${action} · ${paneTitle}` : action;
}

function glyphFor(effect: EntityDropEffectV1, kind: PaneEffectKind): HappierReleaseGlyph {
    if (kind === 'goTo') return 'goTo';
    switch (effectPlacement(effect)) {
        case 'left':
        case 'right': return 'split';
        case 'up':
        case 'down': return 'splitVertical';
        case 'center': return 'tab';
    }
}

/**
 * The carried card's outcome for a pane verdict, or `null` when the verdict is not a pane's (another
 * owner words it). "Already here" is quiet, not a refusal: nothing is wrong, nothing will change.
 */
export function describePaneDropOutcome(input: Readonly<{
    phase: EntityDragDropSnapshot['phase'];
    admission: EntityDropAdmissionV1 | null;
}>): HappierReleaseOutcome | null {
    const admission = input.admission;
    if (!admission) return null;
    if (admission.status === 'refused') {
        if (!ALREADY_HERE_CODES.has(admission.reason.code)) return null;
        return { tone: 'quiet', glyph: 'here', title: admission.preview?.verb ?? t('entityDragDrop.pane.alreadyHere'),
            detail: admission.reason.message };
    }
    const kind = paneEffectKind(admission.effect);
    if (!kind) return null;
    return {
        tone: input.phase === 'pending' ? 'pending' : 'allowed',
        glyph: glyphFor(admission.effect, kind),
        title: admission.effect.preview.verb,
        ...(admission.effect.preview.consequence ? { detail: admission.effect.preview.consequence } : {}),
    };
}

export type PaneDropStripCue = Readonly<{ slot: boolean; pulseTabKey: string | null }>;
const NO_CUE: PaneDropStripCue = Object.freeze({ slot: false, pulseTabKey: null });

/**
 * What one tab strip shows for the current verdict (lab C2): a ghost slot where a kept tab will
 * land when its pane (or the strip's empty end) takes the item, or a ring on the tab an
 * already-open item will go to. `targetIds` are the strip's own pane-centre and strip targets.
 */
export function resolvePaneDropStripCue(snapshot: Pick<EntityDragDropSnapshot, 'phase' | 'targetId' | 'admission'>, input: Readonly<{
    targetIds: readonly string[];
    tabIds: readonly string[];
}>): PaneDropStripCue {
    if (snapshot.phase !== 'carrying' || snapshot.admission?.status !== 'allowed') return NO_CUE;
    const effect = snapshot.admission.effect;
    const kind = paneEffectKind(effect);
    if (!kind) return NO_CUE;
    if (kind === 'goTo') {
        const tabId = effectTabId(effect);
        return tabId && input.tabIds.includes(tabId) ? { slot: false, pulseTabKey: tabId } : NO_CUE;
    }
    const lands = snapshot.targetId !== null && input.targetIds.includes(snapshot.targetId)
        && effectPlacement(effect) === 'center' && !effectAnchored(effect);
    return lands ? { slot: true, pulseTabKey: null } : NO_CUE;
}
