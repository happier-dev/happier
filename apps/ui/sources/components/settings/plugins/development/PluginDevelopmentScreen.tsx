import * as React from 'react';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import { createActionInputForm } from '@/components/plugins/actions/actionInputForm';
import { presentActionInputForm } from '@/components/plugins/actions/presentActionInputForm';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';

import { DevelopmentPluginsSection } from '../PluginMarketplaceSections';
import { PluginReadOnlySnapshotNotice } from '../PluginReadOnlySnapshotNotice';
import { usePluginSettingsScreenState } from '../model/usePluginSettingsScreenState';
import {
    createPluginScaffoldUiModeOptions,
    DEFAULT_PLUGIN_SCAFFOLD_UI_MODE,
    readPluginScaffoldUiMode,
} from './pluginScaffoldUiModeOptions';
import { usePluginAuthoringSession } from './usePluginAuthoringSession';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useMountedShouldContinue } from '@/hooks/ui/useMountedShouldContinue';

function PluginSourceRootDraft(props: Readonly<{
    available: boolean;
    isPending: (sourceRootPath: string) => boolean;
    onSave: (sourceRootPath: string) => void;
    onCancel: () => void;
}>) {
    const [sourceRootPath, setSourceRootPath] = React.useState('');
    const pending = props.isPending(sourceRootPath.trim());
    return (
        <>
            <ItemGroup
                title={t('settingsPlugins.developmentSourceInstall')}
                description={t('settingsPlugins.developmentSourceInstallBody')}
            >
                <SectionContentRow>
                    <FieldItem label={t('settingsPlugins.developmentSourceInstallTitle')}>
                        <FieldTextInput
                            testID="settings.plugins.development.sourceRootPath"
                            accessibilityLabel={t('settingsPlugins.developmentSourceInstallTitle')}
                            value={sourceRootPath}
                            onChangeText={setSourceRootPath}
                            placeholder={t('settingsPlugins.developmentSourceInstallPlaceholder')}
                            autoCapitalize="none"
                            editable={!pending}
                            monospace
                        />
                    </FieldItem>
                </SectionContentRow>
            </ItemGroup>
            <ItemGroup surface="none">
                <SectionButtonRow>
                    <RoundButton
                        testID="settings.plugins.development.sourceRootPath.save"
                        size="small"
                        title={t('common.save')}
                        loading={pending}
                        disabled={!sourceRootPath.trim() || !props.available}
                        onPress={() => {
                            if (props.available && sourceRootPath.trim()) props.onSave(sourceRootPath.trim());
                        }}
                    />
                    <RoundButton
                        testID="settings.plugins.development.sourceRootPath.cancel"
                        size="small"
                        display="secondary"
                        title={t('common.cancel')}
                        disabled={pending}
                        onPress={props.onCancel}
                    />
                </SectionButtonRow>
            </ItemGroup>
        </>
    );
}

/**
 * Settings → Plugins → Development.
 *
 * Its own route rather than a fourth segment: Development is a task a reader
 * leaves Installed and Discover for, so it gets the platform's ordinary
 * heading and Back affordance — Android hardware Back, iOS swipe, web history
 * — instead of a second navigation owner competing with the home screen's one
 * tab bar. It reads the same canonical screen-state owner the home screen does;
 * there is no second plugin store.
 */
export const PluginDevelopmentScreen = React.memo(function PluginDevelopmentScreen() {
    const isFocused = useIsFocused();
    const shouldContinue = useMountedShouldContinue();
    const state = usePluginSettingsScreenState({ focused: isFocused });
    const openPluginAuthoringSession = usePluginAuthoringSession({
        serverId: state.executionServerId,
        machineId: state.executionMachineId,
    });
    const [createdPlugin, setCreatedPlugin] = React.useState<Readonly<{
        pluginId: string;
        sourceRootPath: string;
    }> | null>(null);
    const [sourceRootDraftOpen, setSourceRootDraftOpen] = React.useState(false);

    React.useEffect(() => {
        setCreatedPlugin(null);
        setSourceRootDraftOpen(false);
    }, [state.executionMachineId, state.executionServerId]);

    const openCreatedPluginWithAgent = React.useCallback((created: Readonly<{
        pluginId: string;
        sourceRootPath: string;
    }>) => {
        openPluginAuthoringSession({
            sessionDirectory: created.sourceRootPath,
            promptText: t('settingsPlugins.developmentCreateWithAgentPrompt', {
                pluginId: created.pluginId,
            }),
        });
    }, [openPluginAuthoringSession]);

    /**
     * Both entry points share one transient form. Submitting IS the create
     * decision — the scaffold writes into a directory the user named and that
     * must not already exist — so there is no second confirmation behind it.
     */
    const createDevelopmentPlugin = React.useCallback((withAgent: boolean) => {
        if (!state.daemonOperationsAvailable || !state.developmentCreateAvailable) return;
        const lifetime = withAgent ? captureActiveServerAccountScopeLifetime() : null;
        if (withAgent && !lifetime) return;
        const title = t(withAgent
            ? 'settingsPlugins.developmentCreateWithAgent'
            : 'settingsPlugins.developmentCreate');
        const form = createActionInputForm({
            presentation: {
                title,
                description: t('settingsPlugins.developmentCreateSubtitle'),
                inputHints: {
                    submitLabel: title,
                    fields: [
                        { path: 'targetDir', title: t('settingsPlugins.developmentCreateDirectoryTitle'), description: t('settingsPlugins.developmentCreateDirectoryBody'), widget: 'text', required: true },
                        { path: 'displayName', title: t('settingsPlugins.developmentCreateNameTitle'), description: t('settingsPlugins.developmentCreateNameBody'), widget: 'text', required: true },
                        { path: 'pluginId', title: t('settingsPlugins.developmentCreateIdTitle'), description: t('settingsPlugins.developmentCreateIdBody'), widget: 'text', required: true },
                        {
                            path: 'ui',
                            title: t('settingsPlugins.developmentCreateSurfaceTitle'),
                            description: t('settingsPlugins.developmentCreateSurfaceBody'),
                            widget: 'select',
                            required: true,
                            // Derived from the Protocol scaffold vocabulary, never
                            // a second enum maintained beside it.
                            options: createPluginScaffoldUiModeOptions()
                                .map((option) => ({ value: option.value, label: option.label })),
                        },
                    ],
                },
            },
            submit: async (input, context) => {
                const targetDir = typeof input.targetDir === 'string' ? input.targetDir.trim() : '';
                const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
                const pluginId = typeof input.pluginId === 'string' ? input.pluginId.trim() : '';
                const ui = readPluginScaffoldUiMode(input.ui) ?? DEFAULT_PLUGIN_SCAFFOLD_UI_MODE;
                if (!targetDir || !displayName || !pluginId || context.signal.aborted
                    || (withAgent && lifetime?.isCurrent() !== true) || !shouldContinue()) return { ok: false };
                const settlement = await state.runDevelopmentCreate({
                    targetDir,
                    displayName,
                    pluginId,
                    ui,
                });
                if (settlement.status !== 'success' || context.signal.aborted
                    || (withAgent && lifetime?.isCurrent() !== true) || !shouldContinue()) return { ok: false };
                setCreatedPlugin(settlement.created);
                if (withAgent) openCreatedPluginWithAgent(settlement.created);
                return { ok: true };
            },
        });
        presentActionInputForm({ form });
    }, [openCreatedPluginWithAgent, shouldContinue, state]);

    /**
     * Re-resolves the current admitted source through the selected daemon, then
     * opens the ordinary authoring Session in its canonical working directory.
     */
    const editDevelopmentPluginWithAgent = React.useCallback((editPluginId: string) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return;
        void (async () => {
            const settlement = await state.resolveDevelopmentEditTarget(editPluginId);
            if (settlement.status !== 'success' || !lifetime.isCurrent() || !shouldContinue()) return;
            openPluginAuthoringSession({
                sessionDirectory: settlement.target.sessionDirectory,
                promptText: `${settlement.target.sourceRootPath}\n\n${t(
                    'settingsPlugins.developmentEditWithAgentPrompt',
                    { pluginId: editPluginId },
                )}`,
            });
        })();
    }, [openPluginAuthoringSession, shouldContinue, state]);

    // Adopting an existing file or folder turns authored code into a running
    // development source. The path the user types
    // here is the exact thing the daemon will be asked to trust, so it is echoed
    // back verbatim in the trust decision rather than being summarised.
    const developPluginSourceRoot = React.useCallback(() => {
        if (!state.daemonOperationsAvailable || !state.developmentSourceInstallAvailable) return;
        setSourceRootDraftOpen(true);
    }, [state.daemonOperationsAvailable, state.developmentSourceInstallAvailable]);

    return (
        <ItemList style={{ paddingTop: 0 }} keyboardShouldPersistTaps="handled">
            <SettingsPageHeader
                description={t('settingsPlugins.developerDevelopmentSubtitle')}
                actions={(
                    /* Every action below builds and runs code on exactly this target. */
                    <MachineAdministrationTargetSelector
                        selection={state.administrationTargetSelection}
                        testIDPrefix="settings.plugins.development.target"
                        groupTitle={t('settingsPlugins.administrationMachineTitle')}
                        presentation="chip"
                    />
                )}
            />
            {/* No machine chosen is not a disconnect: the chip above is the next action. */}
            {state.readOnlySnapshotNotice && state.administrationTargetSelection.state.kind !== 'unselected' ? (
                <PluginReadOnlySnapshotNotice
                    testID="settings.plugins.development.readOnlySnapshot"
                    reason={state.readOnlySnapshotNotice.reason}
                    onRetry={state.refreshPluginTruth}
                />
            ) : null}
            {sourceRootDraftOpen ? (
                <PluginSourceRootDraft
                    available={state.daemonOperationsAvailable && state.developmentSourceInstallAvailable}
                    isPending={state.isPluginActionInFlight}
                    onSave={state.runDevelopmentSourceInstall}
                    onCancel={() => setSourceRootDraftOpen(false)}
                />
            ) : null}
            <DevelopmentPluginsSection
                developmentPlugins={state.developmentPlugins}
                createAvailable={state.developmentCreateAvailable}
                sourceInstallAvailable={state.developmentSourceInstallAvailable}
                canRunActions={state.daemonOperationsAvailable}
                machineHomeDir={state.executionMachineHomeDir ?? undefined}
                createdPlugin={createdPlugin}
                operationSettlement={state.routineOperationSettlement}
                isPluginActionInFlight={state.isPluginActionInFlight}
                onCreate={() => {
                    createDevelopmentPlugin(false);
                }}
                onCreateWithAgent={() => {
                    createDevelopmentPlugin(true);
                }}
                onStartCreatedDevelopment={state.runDevelopmentSourceInstall}
                onCreateWithAgentFromCreated={openCreatedPluginWithAgent}
                onDevelopSourceRoot={developPluginSourceRoot}
                onEditWithAgent={editDevelopmentPluginWithAgent}
                onRunAction={state.runDevelopmentAction}
            />
        </ItemList>
    );
});

export default PluginDevelopmentScreen;
