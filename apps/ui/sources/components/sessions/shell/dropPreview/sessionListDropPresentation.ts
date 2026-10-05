import type { HappierReleaseGlyph, HappierReleaseOutcome } from '@happier-dev/plugin-ui/presentation';
import { AnchoredListPositionV1Schema } from '@happier-dev/protocol';
import type { EntityDropAdmissionV1, EntityDropPreviewV1, EntityDropReasonV1 } from '@happier-dev/protocol/plugins/ui';

import type { EntityDragDropSnapshot } from '@/components/ui/treeDragDrop';
import { t } from '@/text';

/**
 * The words of a Session-list drop (DnD lab E1): what releasing does and its limit, or why the place
 * refuses it. The Session domain resolver decides (`drag/resolveSessionListEntityDrop`); this is the
 * one place that says it, for the carried card, the docked keyboard preview, the chooser and the
 * screen-reader announcement alike.
 *
 * `preview.verb` is the complete localized phrase naming the target ("Put under Fix settings modal
 * remount"), so every locale keeps its own word order; `preview.target` is the target's bare name.
 */

export type SessionListDropTargetPreview =
    | Readonly<{ kind: 'put-under'; leadName: string }>
    | Readonly<{ kind: 'reorder'; edge: 'above' | 'below'; siblingName: string }>
    | Readonly<{ kind: 'folder'; folderName: string }>
    | Readonly<{ kind: 'top-level' }>;

export function describeSessionListDropPreview(target: SessionListDropTargetPreview): EntityDropPreviewV1 {
    switch (target.kind) {
        case 'put-under':
            return {
                verb: t('entityDragDrop.preview.putUnder', { target: target.leadName }),
                target: target.leadName,
                consequence: t('entityDragDrop.preview.putUnderDetail'),
            };
        case 'reorder':
            return {
                verb: target.edge === 'above'
                    ? t('entityDragDrop.preview.moveAbove', { target: target.siblingName })
                    : t('entityDragDrop.preview.moveBelow', { target: target.siblingName }),
                target: target.siblingName,
                consequence: t('entityDragDrop.preview.orderDetail'),
            };
        case 'folder':
            return {
                verb: t('entityDragDrop.preview.moveToFolder', { folder: target.folderName }),
                target: target.folderName,
                consequence: t('entityDragDrop.preview.folderDetail'),
            };
        case 'top-level':
            return {
                verb: t('entityDragDrop.preview.moveToTopLevel'),
                target: t('entityDragDrop.keyboard.topLevel'),
                consequence: t('entityDragDrop.preview.topLevelDetail'),
            };
    }
}

/** The refusal headline when the place is a Session that will not take reports. */
export function describeSessionListRefusedPutUnder(leadName: string): EntityDropPreviewV1 {
    return { verb: t('entityDragDrop.preview.cantPutUnder', { target: leadName }), target: leadName };
}

/** The list's code for a pointer over no row or zone; it carries no refusal to say. */
export const SESSION_LIST_NO_TARGET_CODE = 'no-target';

function reasonMessage(code: string): string {
    switch (code) {
        case 'read': return t('entityDragDrop.reasons.read');
        case 'input': return t('entityDragDrop.reasons.input');
        case 'pairwise': return t('entityDragDrop.reasons.pairwise');
        case 'cycle':
        case 'reports_to_cycle':
            return t('entityDragDrop.reasons.cycle');
        case 'already_under': return t('entityDragDrop.reasons.alreadyUnder');
        case 'archived': return t('entityDragDrop.reasons.archived');
        case 'different_home':
        case 'scope-mismatch':
            return t('entityDragDrop.reasons.differentHome');
        case 'unavailable':
        case 'admission-unavailable':
            return t('entityDragDrop.reasons.unavailable');
        case 'date-ordering-mode':
        case 'ordering-mode':
            return t('entityDragDrop.reasons.dateOrder');
        case 'no-change':
        case 'same-position':
            return t('entityDragDrop.reasons.noChange');
        case 'descendant-cycle': return t('entityDragDrop.reasons.descendantCycle');
        case 'max-depth-exceeded': return t('entityDragDrop.reasons.maxDepth');
        case 'feature-disabled': return t('entityDragDrop.reasons.foldersOff');
        case 'target-retired':
        case 'source-retired':
        case 'target-missing':
        case 'source-missing':
        case 'container-missing':
            return t('entityDragDrop.reasons.gone');
        default:
            return t('entityDragDrop.reasons.generic');
    }
}

export function describeSessionListDropReason(code: string): EntityDropReasonV1 {
    return { code, message: reasonMessage(code) };
}

function glyphForEffect(effect: Extract<EntityDropAdmissionV1, { status: 'allowed' }>['effect']): HappierReleaseGlyph {
    if (effect.actionId === 'session.reports_to.set') return 'nest';
    if (effect.actionId === 'widgets.instance.move') return 'above';
    const input = effect.input;
    const record = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Readonly<Record<string, unknown>> : null;
    const nested = record?.move ?? record?.intent;
    const position = AnchoredListPositionV1Schema.safeParse(record?.position
        ?? (nested && typeof nested === 'object' && 'position' in nested ? nested.position : undefined));
    if (position.success) return position.data.placement === 'before' ? 'above' : 'below';
    const instructionKind = record?.instructionKind;
    switch (instructionKind) {
        case 'reorder-before': return 'above';
        case 'reorder-after': return 'below';
        case 'nest-into': return 'folder';
        case 'move-to-root': return 'topLevel';
        default: return 'add';
    }
}

/**
 * The release preview for the drag owner's current verdict. A refused place draws the refusal mark
 * with the owner's reason; a released relation stays visibly uncommitted until its owner answers.
 */
export function describeSessionListDropOutcome(input: Readonly<{
    phase: EntityDragDropSnapshot['phase'];
    admission: EntityDropAdmissionV1 | null;
}>): HappierReleaseOutcome | null {
    const admission = input.admission;
    if (!admission) return null;
    if (admission.status === 'refused') {
        // Over the list but over no place: the card shows only what it carries.
        if (admission.reason.code === SESSION_LIST_NO_TARGET_CODE) return null;
        return {
            tone: 'refused',
            title: admission.preview?.verb ?? t('entityDragDrop.preview.cantMoveHere'),
            detail: admission.reason.message,
        };
    }
    const { effect } = admission;
    if (input.phase === 'pending') {
        return {
            tone: 'pending',
            glyph: glyphForEffect(effect),
            title: effect.actionId === 'session.reports_to.set'
                ? t('entityDragDrop.preview.pendingPutUnder', { target: effect.preview.target })
                : effect.preview.verb,
            detail: t('entityDragDrop.preview.pendingDetail'),
        };
    }
    return {
        tone: 'allowed',
        glyph: glyphForEffect(effect),
        title: effect.preview.verb,
        ...(effect.preview.consequence ? { detail: effect.preview.consequence } : {}),
    };
}
