import * as React from 'react';
import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { SettingsShell } from '@/components/settings/shell/SettingsShell';
import { Typography } from '@/constants/Typography';
import { createHeader } from '@/components/navigation/Header';
import { isRunningOnMac } from '@/utils/platform/platform';
import { t } from '@/text';

function buildHeaderTitleOptions(title: string) {
    return { headerTitle: title };
}

function buildSettingsIndexOptions() {
    return {
        headerShown: true,
        headerTitle: t('settings.title'),
        headerBackTitle: t('common.home'),
    };
}

function buildConnectClaudeOptions() {
    return {
        headerShown: true,
        headerTitle: t('navigation.connectClaude'),
        headerBackTitle: t('common.back'),
    };
}

export default React.memo(function SettingsLayoutRoute() {
    const { theme } = useUnistyles();

    const shouldUseCustomHeader = Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web';

    return (
        <SettingsShell>
            <Stack
                screenOptions={{
                    header: shouldUseCustomHeader ? createHeader : undefined,
                    headerBackTitle: t('common.back'),
                    headerShadowVisible: false,
                    contentStyle: {
                        backgroundColor: theme.colors.surface,
                    },
                    headerStyle: {
                        backgroundColor: theme.colors.header.background,
                    },
                    headerTintColor: theme.colors.header.tint,
                    headerTitleStyle: {
                        color: theme.colors.header.tint,
                        ...Typography.default('semiBold'),
                    },
                }}
            >
                <Stack.Screen
                    name="index"
                    options={buildSettingsIndexOptions()}
                />
                <Stack.Screen name="account" options={buildHeaderTitleOptions(t('settings.account'))} />
                <Stack.Screen name="machines" options={buildHeaderTitleOptions(t('settings.machines'))} />
                <Stack.Screen name="remote-hosts" options={buildHeaderTitleOptions(t('settings.remoteHostsTitle'))} />
                <Stack.Screen name="machines/add" options={buildHeaderTitleOptions(t('setupOnboarding.setupNewMachineAction'))} />
                <Stack.Screen name="machines/this-computer" options={buildHeaderTitleOptions(t('settings.machineSetupCurrentMachineTitle'))} />
                <Stack.Screen name="add-phone" options={buildHeaderTitleOptions(t('settings.addYourPhone'))} />
                <Stack.Screen name="appearance" options={buildHeaderTitleOptions(t('settings.appearance'))} />
                <Stack.Screen name="features" options={buildHeaderTitleOptions(t('settings.features'))} />
                <Stack.Screen name="providers" options={buildHeaderTitleOptions(t('settingsProviders.title'))} />
                <Stack.Screen name="providers/[providerId]" options={buildHeaderTitleOptions(t('settingsProviders.title'))} />
                <Stack.Screen name="plugins" options={buildHeaderTitleOptions(t('settingsPlugins.title'))} />
                <Stack.Screen name="plugins/[pluginId]" options={buildHeaderTitleOptions(t('settingsPlugins.detailTitle'))} />
                <Stack.Screen name="desktop" options={buildHeaderTitleOptions(t('settingsDesktop.title'))} />
                <Stack.Screen name="source-control" options={buildHeaderTitleOptions(t('navigation.sourceControl'))} />
                <Stack.Screen name="report-issue" options={buildHeaderTitleOptions(t('settings.reportIssue'))} />
                <Stack.Screen name="system-status" options={buildHeaderTitleOptions(t('settings.systemStatus'))} />
                <Stack.Screen name="diagnosis" options={buildHeaderTitleOptions(t('diagnosis.title'))} />
                <Stack.Screen name="profiles" options={buildHeaderTitleOptions(t('settingsFeatures.profiles'))} />
                <Stack.Screen name="sub-agent" options={buildHeaderTitleOptions(t('subAgentGuidance.settings.groupTitle'))} />
                <Stack.Screen name="session/tool-rendering" options={buildHeaderTitleOptions(t('settingsSession.toolRendering.title'))} />
                <Stack.Screen name="session/permissions" options={buildHeaderTitleOptions(t('settingsSession.permissions.title'))} />
                <Stack.Screen name="session/handoff" options={buildHeaderTitleOptions(t('settingsSession.handoff.title'))} />
                <Stack.Screen
                    name="connect/claude"
                    options={buildConnectClaudeOptions()}
                />
            </Stack>
        </SettingsShell>
    );
});
