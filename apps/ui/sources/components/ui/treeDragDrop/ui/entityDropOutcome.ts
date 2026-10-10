import {
    describeHappierDropOutcome,
    describeHappierSettledDrop,
    type HappierDropEffect,
    type HappierDropOutcomeVocabulary,
    type HappierDropVerdict,
    type HappierReleaseOutcome,
} from '@happier-dev/plugin-ui/presentation';

import { PANE_DROP_UNCHANGED_CODES } from '@/components/appShell/splitCanvas/presentation/paneDropPresentation';
import { SESSION_LIST_NO_TARGET_CODE } from '@/components/sessions/shell/dropPreview/sessionListDropPresentation';
import { t } from '@/text';

import { WIDGET_MOVE_SILENT_CODES } from '../widgetLayoutEntityDrop';

/**
 * Happier core's words for the ONE outcome presenter (`describeHappierDropOutcome`, plugin-ui): the
 * carried card, every docked keyboard preview, the polite status and the source row's lasting line
 * all describe a verdict through `describeEntityDropOutcome`, so no surface words an outcome twice.
 *
 * Targets declare their mark in the same portable preview as plugins.
 */

const isRelation = (effect: HappierDropEffect) => effect.actionId === 'session.reports_to.set';

/** "Already here": releasing changes nothing, so it is quiet, never a refusal. */
const UNCHANGED_CODES: ReadonlySet<string> = new Set([
    ...PANE_DROP_UNCHANGED_CODES,
    'no-change', 'same-position', 'board-no-change',
]);

function vocabulary(): HappierDropOutcomeVocabulary {
    return {
        pendingTitle: effect => isRelation(effect)
            ? t('entityDragDrop.preview.pendingPutUnder', { target: effect.preview.target })
            : effect.preview.verb,
        pendingDetail: t('entityDragDrop.preview.pendingDetail'),
        refusedTitle: t('entityDragDrop.preview.cantMoveHere'),
        lateRefusalTitle: (effect, item) => isRelation(effect)
            ? item
                ? t('entityDragDrop.settled.refusedPutUnder', { item, target: effect.preview.target })
                : t('entityDragDrop.preview.cantPutUnder', { target: effect.preview.target })
            : t('entityDragDrop.settled.refused', { verb: effect.preview.verb }),
        unknownTitle: effect => t('entityDragDrop.settled.unknown', { verb: effect.preview.verb }),
        unknownDetail: t('entityDragDrop.preview.unknownDetail'),
        unchangedCodes: UNCHANGED_CODES,
        silentCodes: new Set([SESSION_LIST_NO_TARGET_CODE, ...WIDGET_MOVE_SILENT_CODES]),
    };
}

/** The release preview for the drag owner's verdict, in Happier's words. */
export function describeEntityDropOutcome(verdict: HappierDropVerdict, itemTitle: string | null = null): HappierReleaseOutcome | null {
    return describeHappierDropOutcome(verdict, vocabulary(), itemTitle);
}

/** A dispatched effect its owner refused or could not confirm, as the source row keeps it. */
export function describeEntityDropSettled(verdict: HappierDropVerdict, itemTitle: string | null = null) {
    return describeHappierSettledDrop(verdict, vocabulary(), itemTitle);
}
