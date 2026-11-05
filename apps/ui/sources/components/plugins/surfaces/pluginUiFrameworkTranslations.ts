import { HAPPIER_WORK_STATUS_BUCKET_LABEL_KEYS, HAPPIER_WORK_STATUS_BUCKETS } from '@happier-dev/plugin-ui/presentation';

import { describeWorkStatusBucket } from '@/components/work/status/workStatusBuckets';
import { t } from '@/text';

/**
 * The host-reserved `happier.plugin-ui.*` strings: the chrome plugin-ui's own components draw (form submit, a
 * list's overflow, a pushed detail's back control), in the app's locale. One owner for every same-realm mount —
 * a plugin surface projects them after its author strings so a plugin cannot replace a fixed host action, and a
 * core page rendering public components reads the same set.
 */
export function resolvePluginUiFrameworkTranslations(): Readonly<Record<string, string>> {
    return {
        'happier.plugin-ui.form.submit': t('common.submit'),
        'happier.plugin-ui.form.cancel': t('common.cancel'),
        'happier.plugin-ui.action.execute': t('common.run'),
        'happier.plugin-ui.action.copy': t('common.copy'),
        'happier.plugin-ui.action.open': t('common.open'),
        'happier.plugin-ui.action.copied': t('common.copied'),
        'happier.plugin-ui.action.refresh': t('common.refresh'),
        // The public `ApprovalPendingNotice`: the same words as Happier's own waiting notices.
        'happier.plugin-ui.approvalPending.title': t('settingsProvidersCollection.approvalPendingTitle'),
        'happier.plugin-ui.approvalPending.open': t('settingsProvidersCollection.openApproval'),
        // What a refused Action means, for a page that shows `useExecutePluginAction`'s message.
        'happier.plugin-ui.action.error.failed': t('ui.pluginUi.actionFailed'),
        'happier.plugin-ui.action.error.unavailable': t('ui.pluginUi.actionUnavailable'),
        'happier.plugin-ui.action.error.denied': t('ui.pluginUi.actionDenied'),
        'happier.plugin-ui.action.error.stale': t('ui.pluginUi.actionStale'),
        'happier.plugin-ui.action.error.noAnswer': t('ui.pluginUi.actionNoAnswer'),
        'happier.plugin-ui.state.loading': t('ui.pluginUi.loading'),
        'happier.plugin-ui.state.refreshing': t('pluginSurfaces.state.refreshing.title'),
        'happier.plugin-ui.state.stale': t('pluginSurfaces.state.stale.title'),
        'happier.plugin-ui.state.empty': t('ui.pluginUi.empty'),
        'happier.plugin-ui.state.error': t('ui.pluginUi.error'),
        'happier.plugin-ui.state.details': t('common.details'),
        'happier.plugin-ui.state.collapseDetails': t('common.collapse'),
        'happier.plugin-ui.state.retry': t('common.retry'),
        // A template: the public `FreshnessLine` puts its time into `{time}`, keeping each locale's order.
        'happier.plugin-ui.state.asOf': t('surfaceState.asOf', { time: '{time}' }),
        'happier.plugin-ui.list.moreActions': t('ui.pluginUi.moreActions'),
        'happier.plugin-ui.resize.label': t('ui.resizableDockedPane.resizeA11y'),
        'happier.plugin-ui.resize.hint': t('ui.resizableDockedPane.resizeHint'),
        // Translation functions interpolate this numeric parameter verbatim; the component fills the template.
        'happier.plugin-ui.resize.value': t('ui.resizableDockedPane.resizeValue', { px: '{px}' as unknown as number }),
        'happier.plugin-ui.collection.board.empty': t('ui.pluginUi.collectionEmpty'),
        'happier.plugin-ui.select.choose': t('common.choose'),
        // A template: a multiple choice names how many are chosen, and the plugin-ui field fills `{count}`.
        'happier.plugin-ui.select.count': t('pluginSurfaces.selectCount'),
        'happier.plugin-ui.select.empty': t('settingsAgents.noOptionsAvailable'),
        'happier.plugin-ui.select.search': t('common.search'),
        'happier.plugin-ui.select.noMatches': t('common.noMatches'),
        'happier.plugin-ui.detailsPane.back': t('common.back'),
        'happier.plugin-ui.modalHeader.close': t('common.close'),
        // A segmented choice whose value follows a default announces it ("Ask, default").
        'happier.plugin-ui.segmented.inherited': t('capabilities.detail.inheritedValue'),
        // Templates: the public `PresenceCapsule` puts the agent's name into `{agent}`.
        'happier.plugin-ui.presence.stopping': t('browserPresence.stopping', { agent: '{agent}' }),
        'happier.plugin-ui.presence.stoppingDetail': t('browserPresence.stoppingDetail'),
        'happier.plugin-ui.presence.youHaveControl': t('browserPresence.youHaveControl'),
        'happier.plugin-ui.presence.pausedUntilHandBack': t('browserPresence.pausedUntilHandBack', { agent: '{agent}' }),
        'happier.plugin-ui.presence.stopUnconfirmed': t('browserPresence.stopUnconfirmed'),
        'happier.plugin-ui.presence.lastActionMayHaveLanded': t('browserPresence.lastActionMayHaveLanded', { agent: '{agent}' }),
        'happier.plugin-ui.presence.takeControl': t('browserPresence.takeControl'),
        'happier.plugin-ui.presence.handBack': t('browserPresence.handBack'),
        'happier.plugin-ui.presence.checkAgain': t('browserPresence.checkAgain'),
        'happier.plugin-ui.presence.watch': t('browserTool.watch'),
        // The public `ReturnedAnswerQuote`: the same words core's own returned answers use.
        ...Object.fromEntries(([['answer', 'answered'], ['pass', 'passed'], ['failed', 'failed'], ['cancelled', 'cancelled'],
            ['terminal_no_result', 'noResult']] as const).map(([outcome, copy]) => [`happier.plugin-ui.returnedAnswer.outcome.${outcome}`, t(`session.returnedAnswer.${copy}`)])),
        'happier.plugin-ui.returnedAnswer.open': t('session.returnedAnswer.open'),
        'happier.plugin-ui.returnedAnswer.information': t('session.returnedAnswer.asInformation'),
        'happier.plugin-ui.returnedAnswer.yourQuestion': t('session.returnedAnswer.yourQuestion'),
        'happier.plugin-ui.returnedAnswer.askedFromHere': t('session.returnedAnswer.askedFromHere'),
        'happier.plugin-ui.returnedAnswer.openQuestion': t('session.returnedAnswer.openQuestion'),
        'happier.plugin-ui.returnedAnswer.questionUnavailable': t('session.returnedAnswer.questionUnavailable'),
        // The public `FollowPolicyEditor`: presets, what each means, and every Follow event's name, in the app's words.
        ...resolveFollowPolicyEditorTranslations(),
        // The Work status bucket labels, from the one label owner core's own lists read.
        ...Object.fromEntries(HAPPIER_WORK_STATUS_BUCKETS.map((bucket) => [
            HAPPIER_WORK_STATUS_BUCKET_LABEL_KEYS[bucket],
            describeWorkStatusBucket(bucket),
        ])),
    };
}

const FOLLOW_EVENT_COPY = {
    needs_you: 'needsYou', 'needs_you.decision': 'decision', 'needs_you.approval': 'approval', 'needs_you.blocked': 'blocked',
    finished: 'finished', failed_or_stopped: 'failedOrStopped', stalled: 'stalled', update_posted: 'updatePosted',
    person_wrote: 'personWrote', goal_changed: 'goalChanged', message: 'message',
} as const;
const FOLLOW_EVENT_DESCRIPTION_COPY = { needs_you: 'needsYou', failed_or_stopped: 'failedOrStopped', person_wrote: 'personWrote' } as const;

function resolveFollowPolicyEditorTranslations(): Readonly<Record<string, string>> {
    const key = 'happier.plugin-ui.follow';
    return {
        [`${key}.presetLabel`]: t('session.follow.policyEditor.presetLabel'),
        [`${key}.customTitle`]: t('session.follow.policyEditor.customTitle'),
        ...Object.fromEntries((['everything', 'important', 'quiet', 'custom'] as const).flatMap((preset) => [
            [`${key}.preset.${preset}`, t(`session.follow.policy.${preset}`)],
            [`${key}.presetDescription.${preset}`, t(`session.follow.policyEditor.presetDescription.${preset}`)],
        ])),
        ...Object.fromEntries((['off', 'quiet', 'interrupt'] as const).map((delivery) => [`${key}.delivery.${delivery}`, t(`session.follow.policyEditor.delivery.${delivery}`)])),
        // A Session receiver gets the same two channels as Wake and Next turn.
        [`${key}.session.presetLabel`]: t('session.follow.policyEditor.session.presetLabel'),
        ...Object.fromEntries((['everything', 'important', 'quiet', 'custom'] as const).map((preset) => [`${key}.session.presetDescription.${preset}`, t(`session.follow.policyEditor.session.presetDescription.${preset}`)])),
        ...Object.fromEntries((['interrupt', 'quiet'] as const).map((delivery) => [`${key}.session.delivery.${delivery}`, t(`session.follow.policyEditor.session.delivery.${delivery}`)])),
        ...Object.fromEntries(Object.entries(FOLLOW_EVENT_COPY).map(([id, copy]) => [`${key}.event.${id}`, t(`session.follow.policyEditor.events.${copy}`)])),
        ...Object.fromEntries(Object.entries(FOLLOW_EVENT_DESCRIPTION_COPY).map(([id, copy]) => [`${key}.eventDescription.${id}`, t(`session.follow.policyEditor.eventDescriptions.${copy}`)])),
    };
}
