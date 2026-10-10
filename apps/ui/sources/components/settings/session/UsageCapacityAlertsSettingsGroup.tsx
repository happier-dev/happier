import * as React from 'react';
import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';
import { SESSION_PROVIDER_LIMITS_SETTINGS } from '@/components/settings/session/sessionProviderLimitsSettings';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { readUsagePersonalPaceTarget, setUsagePersonalPaceTarget } from '@/components/settings/usage/widgets/plans/usagePacingTarget';

const DAY_MS = 24 * 60 * 60 * 1000;
type Toggle = 'pace' | 'depletion' | 'reset' | 'unused';
type Lead = 'off' | '1' | '2';
type Remaining = 'off' | '10' | '25';

const TARGET_CHOICES = ['off', '50', '75', '90'] as const;
/** A target written elsewhere (an agent, another device) keeps its own value as a choice instead of reading as off. */
const toTarget = (fraction: number | null): string => fraction === null ? 'off' : String(Math.round(fraction * 100));
const toLead = (ms: number | null): Lead => ms === DAY_MS ? '1' : ms === 2 * DAY_MS ? '2' : 'off';
const fromLead = (lead: Lead): number | null => lead === 'off' ? null : Number(lead) * DAY_MS;
const toRemaining = (fraction: number | null): Remaining => fraction === 0.1 ? '10' : fraction === 0.25 ? '25' : 'off';
const fromRemaining = (choice: Remaining): number | null => choice === 'off' ? null : Number(choice) / 100;

/**
 * The personal pace target (lab `p2budget`, advice only) and capacity alerts (lab `p2alerts` N3): the Account's usage notification choices, written to the one
 * `usageQuotaNotificationsV1` preference the daemon's lifecycle notifier reads. Every alert is off
 * until chosen; thresholds are the viewer's choice, never a default.
 */
export const UsageCapacityAlertsSettingsGroup = React.memo(function UsageCapacityAlertsSettingsGroup() {
    const enabled = useFeatureEnabled('connectedServices.quotas');
    const [alerts, setAlerts] = useSettingMutable('usageQuotaNotificationsV1');
    const [targets, setTargets] = useSettingMutable('usagePacingTargetsV1');
    const target = readUsagePersonalPaceTarget(targets);
    const settings = SESSION_PROVIDER_LIMITS_SETTINGS.settings;
    if (!enabled) return null;
    const toggles: readonly Readonly<{ key: Toggle; setting: (typeof settings)['alertPace']; subtitle: string }>[] = [
        { key: 'pace', setting: settings.alertPace, subtitle: t('usage.board.plans.alertPaceSubtitle') },
        { key: 'depletion', setting: settings.alertDepletion, subtitle: t('usage.board.plans.alertDepletionSubtitle') },
        { key: 'reset', setting: settings.alertReset, subtitle: t('usage.board.plans.alertResetSubtitle') },
        { key: 'unused', setting: settings.alertUnused, subtitle: t('usage.board.plans.alertUnusedSubtitle') },
    ];
    const leadOptions = (['off', '1', '2'] as const).map((id) => ({
        id, label: id === 'off' ? t('usage.board.plans.alertOff') : t('usage.board.plans.alertDaysBefore', { count: Number(id) }),
    }));
    return (
        <ItemGroup title={t('usage.board.plans.alertsTitle')} description={t('usage.board.plans.alertsDescription')}>
            <SettingAnchor setting={settings.personalPaceTarget}>
                <SegmentedChoiceItem<string>
                    testID="settings-usage-pace-target"
                    testIDPrefix="settings-usage-pace-target"
                    title={t(settings.personalPaceTarget.titleKey)}
                    subtitle={t('usage.board.plans.targetSubtitle')}
                    subtitleLines={0}
                    options={[...new Set<string>([...TARGET_CHOICES, toTarget(target)])].map((id) => ({
                        id, label: id === 'off' ? t('usage.board.plans.alertOff') : t('usage.board.plans.targetPercent', { percent: Number(id) }),
                    }))}
                    value={toTarget(target)}
                    onChange={(choice) => setTargets(setUsagePersonalPaceTarget(targets, choice === 'off' ? null : Number(choice) / 100))}
                />
            </SettingAnchor>
            {toggles.map((toggle) => (
                <SettingRow
                    key={toggle.key}
                    setting={toggle.setting}
                    testID={`settings-usage-alerts-${toggle.key}`}
                    subtitle={toggle.subtitle}
                    rightElement={<Switch testID={`settings-usage-alerts-${toggle.key}-toggle`} value={alerts[toggle.key]}
                        onValueChange={(value) => setAlerts({ ...alerts, [toggle.key]: value })} />}
                    showChevron={false}
                    onPress={() => setAlerts({ ...alerts, [toggle.key]: !alerts[toggle.key] })}
                />
            ))}
            <SettingAnchor setting={settings.alertAlmostOut}>
                <SegmentedChoiceItem<Remaining>
                    testID="settings-usage-alerts-almostOut"
                    testIDPrefix="settings-usage-alerts-almostOut"
                    title={t(settings.alertAlmostOut.titleKey)}
                    options={(['off', '10', '25'] as const).map((id) => ({
                        id, label: id === 'off' ? t('usage.board.plans.alertOff') : t('usage.board.plans.alertPercentLeft', { percent: Number(id) }),
                    }))}
                    value={toRemaining(alerts.almostOutRemainingFraction)}
                    onChange={(choice) => setAlerts({ ...alerts, almostOutRemainingFraction: fromRemaining(choice) })}
                />
            </SettingAnchor>
            <SettingAnchor setting={settings.alertEnding}>
                <SegmentedChoiceItem<Lead>
                    testID="settings-usage-alerts-ending"
                    testIDPrefix="settings-usage-alerts-ending"
                    title={t(settings.alertEnding.titleKey)}
                    options={leadOptions}
                    value={toLead(alerts.endingBeforeMs)}
                    onChange={(lead) => setAlerts({ ...alerts, endingBeforeMs: fromLead(lead) })}
                />
            </SettingAnchor>
            <SettingAnchor setting={settings.alertCreditExpiry}>
                <SegmentedChoiceItem<Lead>
                    testID="settings-usage-alerts-creditExpiry"
                    testIDPrefix="settings-usage-alerts-creditExpiry"
                    title={t(settings.alertCreditExpiry.titleKey)}
                    options={leadOptions}
                    value={toLead(alerts.creditExpiryBeforeMs)}
                    onChange={(lead) => setAlerts({ ...alerts, creditExpiryBeforeMs: fromLead(lead) })}
                />
            </SettingAnchor>
        </ItemGroup>
    );
});
