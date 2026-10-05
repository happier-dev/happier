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
        'happier.plugin-ui.action.refresh': t('common.refresh'),
        'happier.plugin-ui.state.loading': t('ui.pluginUi.loading'),
        'happier.plugin-ui.state.empty': t('ui.pluginUi.empty'),
        'happier.plugin-ui.state.error': t('ui.pluginUi.error'),
        'happier.plugin-ui.state.details': t('common.details'),
        // A template: the public `FreshnessLine` puts its time into `{time}`, keeping each locale's order.
        'happier.plugin-ui.state.asOf': t('surfaceState.asOf', { time: '{time}' }),
        'happier.plugin-ui.list.moreActions': t('ui.pluginUi.moreActions'),
        'happier.plugin-ui.collection.board.empty': t('ui.pluginUi.collectionEmpty'),
        'happier.plugin-ui.select.choose': t('common.choose'),
        'happier.plugin-ui.detailsPane.back': t('common.back'),
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
        // The Work status bucket labels, from the one label owner core's own lists read.
        ...Object.fromEntries(HAPPIER_WORK_STATUS_BUCKETS.map((bucket) => [
            HAPPIER_WORK_STATUS_BUCKET_LABEL_KEYS[bucket],
            describeWorkStatusBucket(bucket),
        ])),
    };
}
