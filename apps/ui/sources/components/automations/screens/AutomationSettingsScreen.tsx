import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import {
    AutomationV3SettingsSchema,
    type AutomationV3Settings,
} from '@happier-dev/protocol';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';

/**
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

    const applySettings = React.useCallback(async (next: AutomationV3Settings) => {
        if (saving) return;
        const requestAccountLifetime = accountLifetime;
        const requestEpoch = requestEpochRef.current + 1;
        requestEpochRef.current = requestEpoch;
        setSaving(true);
        try {
            const updated = await sync.updateAutomationSettings(next);
            if (requestEpoch !== requestEpochRef.current || requestAccountLifetime?.isCurrent() === false) return;
            setSettings(updated);
        } catch (error) {
            if (requestEpoch !== requestEpochRef.current || requestAccountLifetime?.isCurrent() === false) return;
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.settings.updateFailed'),
            );
        } finally {
            if (requestEpoch === requestEpochRef.current && requestAccountLifetime?.isCurrent() !== false) {
                setSaving(false);
            }
        }
    }, [accountLifetime, saving]);

    const handleMaxActiveRuns = React.useCallback(async () => {
        if (settings === null || saving) return;
        const requestEpoch = requestEpochRef.current;
        const value = await Modal.prompt(
            t('automations.settings.maxActiveRunsPerMachine'),
            t('automations.settings.maxActiveRunsPerMachinePrompt'),
            {
                defaultValue: String(settings.maxActiveRunsPerMachine),
                inputType: 'numeric',
                confirmText: t('common.save'),
            },
        );
        if (value === null) return;
        if (requestEpoch !== requestEpochRef.current) return;
        const parsed = Number(value.trim());
        const candidate = AutomationV3SettingsSchema.safeParse({
            ...settings,
            maxActiveRunsPerMachine: parsed,
        });
        if (!candidate.success) {
            await Modal.alert(t('common.error'), t('automations.settings.maxActiveRunsPerMachineInvalid'));
            return;
        }
        await applySettings(candidate.data);
    }, [applySettings, saving, settings]);

    const handleRetentionChange = React.useCallback((keepForever: boolean) => {
        if (settings === null || saving) return;
        void applySettings({
            ...settings,
            runRetention: keepForever ? 'keepForever' : 'thirtyDays',
        });
    }, [applySettings, saving, settings]);

    if (loading && settings === null) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            </View>
        );
    }

    if (settings === null) {
        return (
            <ItemList>
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
            {loadFailed ? (
                <ItemGroup>
                    <Item
                        testID="automation-settings-stale-load-error"
                        title={t('automations.settings.failedToLoad')}
                        mode="info"
                        showChevron={false}
                        accessibilityRole="alert"
                        accessibilityLiveRegion="assertive"
                        webRole="alert"
                    />
                    <Item
                        testID="automation-settings-stale-load-retry"
                        title={t('common.retry')}
                        onPress={() => { void refresh(); }}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
            <ItemGroup title={t('automations.settings.title')}>
                <Item
                    testID="automation-settings-max-active-runs"
                    title={t('automations.settings.maxActiveRunsPerMachine')}
                    subtitle={t('automations.settings.maxActiveRunsPerMachineSubtitle')}
                    subtitleLines={0}
                    detail={String(settings.maxActiveRunsPerMachine)}
                    onPress={saving ? undefined : () => { void handleMaxActiveRuns(); }}
                    disabled={saving}
                    showChevron={false}
                />
                <Item
                    testID="automation-settings-run-retention"
                    title={t('automations.settings.runRetention')}
                    subtitle={t('automations.settings.runRetentionSubtitle')}
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
