import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
    AutomationV3SettingsSchema,
    SettingsDeclarationActionOutputSchemasV1,
    type AutomationV3Settings,
} from '@happier-dev/protocol';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { formatAutomationErrorMessage } from '@/components/automations/automationErrorFormatting';
import { WORKFLOW_RUN_SETTINGS } from '@/components/automations/settings/workflowRunSettings';
import { SettingAnchor, SettingRow } from '@/components/settings/shell/SettingRow';


/**
 * Workflows › Run settings (`/workflows/settings`, FIN 07 S6): how many runs each machine takes at
 * once and how long run history is kept. Its rows render from their search declarations.
 *
 * This screen presents the server-owned settings record directly. Its local
 * state is only the current route projection and request state; it never
 * becomes another Automation settings store or retention-policy owner.
 */
export function AutomationSettingsScreen(): React.ReactElement {
    const { theme } = useUnistyles();
    // Subscribe through the incumbent storage owner so an Account switch
    // remounts this route-local projection even when the route itself stays put.
    useActiveServerAccountScope();
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const executeAction = React.useMemo(() => createFrontDoorUiActionExecutor(undefined, accountLifetime ? {
        serverId: accountLifetime.scope.serverId,
        expectedAccountId: accountLifetime.scope.accountId,
    } : undefined), [accountLifetime]);
    const [settings, setSettings] = React.useState<AutomationV3Settings | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [loadFailed, setLoadFailed] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const requestEpochRef = React.useRef(0);
    // This ref only decides whether a route-local refresh should replace the
    // projection with a loading placeholder. The server remains the settings
    // authority; the displayed settings themselves stay in React state.
    const hasLoadedSettingsRef = React.useRef(false);

    const refresh = React.useCallback(async () => {
        const requestAccountLifetime = accountLifetime;
        const requestEpoch = requestEpochRef.current + 1;
        requestEpochRef.current = requestEpoch;
        setLoadFailed(false);
        if (!hasLoadedSettingsRef.current) setLoading(true);
        try {
            const next = await sync.getAutomationSettings();
            if (requestEpoch !== requestEpochRef.current || requestAccountLifetime?.isCurrent() === false) return;
            hasLoadedSettingsRef.current = true;
            setSettings(next);
        } catch {
            if (requestEpoch !== requestEpochRef.current || requestAccountLifetime?.isCurrent() === false) return;
            setLoadFailed(true);
        } finally {
            if (requestEpoch === requestEpochRef.current && requestAccountLifetime?.isCurrent() !== false) {
                setLoading(false);
            }
        }
    }, [accountLifetime]);

    React.useEffect(() => {
        requestEpochRef.current += 1;
        hasLoadedSettingsRef.current = false;
        setSettings(null);
        setLoading(true);
        setLoadFailed(false);
        setSaving(false);
        const retirement = accountLifetime?.onRetire(() => {
            requestEpochRef.current += 1;
            hasLoadedSettingsRef.current = false;
            setSettings(null);
            setLoading(true);
            setLoadFailed(false);
            setSaving(false);
        });
        void refresh();
        return () => {
            requestEpochRef.current += 1;
            retirement?.dispose();
        };
    }, [accountLifetime, refresh]);

    const applySetting = React.useCallback(async (anchor: string, value: number | AutomationV3Settings['runRetention']) => {
        if (saving) return;
        const requestAccountLifetime = accountLifetime;
        const requestEpoch = requestEpochRef.current + 1;
        requestEpochRef.current = requestEpoch;
        setSaving(true);
        try {
            SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(await executeAction('settings.set', { anchor, value }));
            const updated = await sync.getAutomationSettings();
            if (requestEpoch !== requestEpochRef.current || requestAccountLifetime?.isCurrent() === false) return;
            setSettings(updated);
        } catch (error) {
            if (requestEpoch !== requestEpochRef.current || requestAccountLifetime?.isCurrent() === false) return;
            await Modal.alert(
                t('workflows.destination.runSettingsPage.saveFailed'),
                formatAutomationErrorMessage(error, t('automations.settings.updateFailed')),
            );
        } finally {
            if (requestEpoch === requestEpochRef.current && requestAccountLifetime?.isCurrent() !== false) {
                setSaving(false);
            }
        }
    }, [accountLifetime, executeAction, saving]);

    // The limit is typed in place (`FieldValueItem`). A value the settings contract rejects is not
    // written, and the field says why until the draft changes.
    const savedMaxActiveRuns = settings === null ? '' : String(settings.maxActiveRunsPerMachine);
    const [maxActiveRunsInvalid, setMaxActiveRunsInvalid] = React.useState(false);
    React.useEffect(() => {
        setMaxActiveRunsInvalid(false);
    }, [savedMaxActiveRuns]);
    const clearMaxActiveRunsRefusal = React.useCallback(() => setMaxActiveRunsInvalid(false), []);

    const commitMaxActiveRuns = React.useCallback((draft: string) => {
        if (settings === null || saving) return;
        const candidate = AutomationV3SettingsSchema.safeParse({
            ...settings,
            maxActiveRunsPerMachine: Number(draft),
        });
        if (!candidate.success) {
            setMaxActiveRunsInvalid(true);
            return;
        }
        setMaxActiveRunsInvalid(false);
        void applySetting(WORKFLOW_RUN_SETTINGS.settings.maxActiveRunsPerMachine.anchor, candidate.data.maxActiveRunsPerMachine);
    }, [applySetting, saving, settings]);

    const handleRetentionChange = React.useCallback((keepForever: boolean) => {
        if (settings === null || saving) return;
        void applySetting(WORKFLOW_RUN_SETTINGS.settings.runRetention.anchor, keepForever ? 'keepForever' : 'thirtyDays');
    }, [applySetting, saving, settings]);

    // The page keeps its header through loading and failure, so nothing above the settings moves
    // when they arrive.
    const header = (
        <PageHeader
            title={t('workflows.destination.runSettingsPage.title')}
            description={t('workflows.destination.runSettingsPage.description')}
        />
    );

    if (loading && settings === null) {
        return (
            <ItemList>
                {header}
                <View style={{ alignItems: 'center', paddingVertical: 32 }}>
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                </View>
            </ItemList>
        );
    }

    if (settings === null) {
        return (
            <ItemList>
                {header}
                <SurfaceStateCard
                    testID="automation-settings-load-error"
                    kind="error"
                    title={t('common.error')}
                    reason={t('automations.settings.failedToLoad')}
                    action={{
                        label: t('common.retry'),
                        onPress: () => { void refresh(); },
                    }}
                    accessibilitySemantics="alert"
                />
            </ItemList>
        );
    }

    return (
        <ItemList>
            {header}
            {loadFailed ? (
                <AttentionBanner
                    testID="automation-settings-stale-load-error"
                    title={t('automations.settings.failedToLoad')}
                    announce="alert"
                    accessibilityLiveRegion="assertive"
                    action={{ label: t('common.retry'), onPress: () => { void refresh(); }, testID: 'automation-settings-stale-load-retry' }}
                />
            ) : null}
            <ItemGroup
                title={t('automationPages.settings.capacityTitle')}
                description={t('automationPages.settings.capacityDescription')}
            >
                <SettingAnchor setting={WORKFLOW_RUN_SETTINGS.settings.maxActiveRunsPerMachine}>
                    <FieldValueItem
                        testID="automation-settings-max-active-runs"
                        title={t(WORKFLOW_RUN_SETTINGS.settings.maxActiveRunsPerMachine.titleKey)}
                        subtitle={t('automations.settings.maxActiveRunsPerMachineSubtitle')}
                        subtitleLines={0}
                        disabled={saving}
                        value={savedMaxActiveRuns}
                        kind="integer"
                        fieldTestID="automation-settings-max-active-runs-field"
                        error={maxActiveRunsInvalid ? t('automations.settings.maxActiveRunsPerMachineInvalid') : null}
                        onDraftChange={clearMaxActiveRunsRefusal}
                        onCommit={commitMaxActiveRuns}
                    />
                </SettingAnchor>
            </ItemGroup>
            <ItemGroup
                title={t('automationPages.settings.historyTitle')}
                description={t('automationPages.settings.historyDescription')}
            >
                <SettingRow
                    setting={WORKFLOW_RUN_SETTINGS.settings.runRetention}
                    testID="automation-settings-run-retention"
                    subtitleLines={0}
                    showChevron={false}
                    rightElement={(
                        <Switch
                            value={settings.runRetention === 'keepForever'}
                            onValueChange={handleRetentionChange}
                            disabled={saving}
                            accessibilityLabel={t('automations.settings.runRetention')}
                            accessibilityHint={t('automations.settings.runRetentionSubtitle')}
                        />
                    )}
                />
            </ItemGroup>
        </ItemList>
    );
}
