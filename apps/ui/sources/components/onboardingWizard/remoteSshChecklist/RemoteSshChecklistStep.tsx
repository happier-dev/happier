import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';

import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import { Modal } from '@/modal';
import type { SshCredentialsDraft } from '@/components/settings/machines/shared/SshCredentialsFields';
import { WizardSshCredentialsFields } from '@/components/onboardingWizard/ssh/WizardSshCredentialsFields';
import { useRemoteSshBootstrapTask } from '@/components/settings/machines/useRemoteSshBootstrapTask';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import type { PlanChecklistExecutionState, PlanChecklistItem, PlanChecklistLogEntry } from '@/components/systemTasks/planChecklist';
import { PlanChecklistCard } from '@/components/systemTasks/planChecklist';

import { buildRemoteSshChecklistItems, getRemoteSshSelectedItemIds } from './buildRemoteSshChecklistItems';
import { mapRemoteSshTaskToChecklistExecution } from './mapRemoteSshTaskToChecklistExecution';
import type { RemoteSshChecklistMode, RemoteSshChecklistPhase } from './remoteSshChecklistTypes';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        gap: 16,
    },
    heading: {
        gap: 6,
        alignItems: 'center',
    },
    title: {
        color: theme.colors.text,
        textAlign: 'center',
    },
    subtitle: {
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    planSummary: {
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    promptCard: {
        width: '100%',
        gap: 10,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        padding: 16,
        backgroundColor: theme.colors.surface,
    },
    promptTitle: {
        color: theme.colors.text,
    },
    promptBody: {
        color: theme.colors.textSecondary,
    },
    footer: {
        gap: 10,
    },
}));

function createDefaultDraft(): SshCredentialsDraft {
    return {
        username: '',
        host: '',
        port: '',
        authMode: 'agent',
        identityFilePath: '',
        password: '',
    };
}

function isDraftReady(draft: SshCredentialsDraft): boolean {
    return draft.username.trim().length > 0 && draft.host.trim().length > 0;
}

function toPlanChecklistItem(item: { id: string; title: string; subtitle: string; selected: boolean; disabled: boolean; optional: boolean; details: string }): PlanChecklistItem {
    return {
        id: item.id,
        title: item.title,
        subtitle: item.subtitle,
        satisfied: false,
        disabled: item.disabled,
        defaultSelected: item.selected,
        badge: item.optional ? 'Optional' : undefined,
        details: item.details,
    };
}

function toPlanLogEntries(lines: readonly string[]): readonly PlanChecklistLogEntry[] {
    return lines.map((message, index) => ({
        ts: index,
        level: 'info',
        message,
    }));
}

function toPlanExecutionState(execution: { status: string; logs: readonly string[]; errorMessage: string | null }): PlanChecklistExecutionState {
    const status = execution.status === 'waiting'
        ? 'running'
        : (execution.status as PlanChecklistExecutionState['status']);
    return {
        status: status === 'idle' || status === 'queued' || status === 'running' || status === 'done' || status === 'error'
            ? status
            : 'idle',
        logs: toPlanLogEntries(execution.logs ?? []),
        error: execution.errorMessage
            ? { title: t('common.error'), message: execution.errorMessage }
            : undefined,
    };
}

export const RemoteSshChecklistStep = React.memo(function RemoteSshChecklistStep(props: Readonly<{
    testID?: string;
    mode: RemoteSshChecklistMode;
    relayUrl: string;
    webappUrl?: string;
    publicRelayUrl?: string;
    initialDraft?: Partial<SshCredentialsDraft>;
    initialInstallRelayRuntime?: boolean;
    runner?: SystemTaskRunner;
    onWizardPrimaryChange?: (state: Readonly<{ label: string; disabled: boolean; onPress: (() => void) | (() => Promise<void>) }> | null) => void;
    onWizardBackChange?: (state: Readonly<{ hidden?: boolean; label?: React.ReactNode; onPress?: () => void }> | null) => void;
    onWizardSkipChange?: (state: Readonly<{ hidden?: boolean; label?: React.ReactNode; disabled?: boolean; onPress?: () => void }> | null) => void;
    onRequestAdvance?: () => void;
    onCompleted?: (payload: Readonly<{
        machineId: string | null;
        relayRuntimeUrl: string | null;
        mode: RemoteSshChecklistMode;
    }>) => void;
    onCancel?: () => void;
}>) {
    useUnistyles();
    const styles = stylesheet;
    const [phase, setPhase] = React.useState<RemoteSshChecklistPhase>('credentials');
    const [draft, setDraft] = React.useState<SshCredentialsDraft>(() => ({
        ...createDefaultDraft(),
        ...(props.initialDraft ?? {}),
    }));
    const [installRelayRuntime, setInstallRelayRuntime] = React.useState(
        Boolean(props.initialInstallRelayRuntime ?? props.mode === 'remoteRelayHost'),
    );
    const [expandedItemId, setExpandedItemId] = React.useState<string | null>(null);
    const [startErrorMessage, setStartErrorMessage] = React.useState<string | null>(null);

    const {
        activeTaskSnapshot,
        answerPasswordPrompt,
        cancel,
        completedMachineId,
        continueAfterPrompt,
        dismissPrompt,
        isStarting,
        prompt,
        resetPromptResolution,
        start,
    } = useRemoteSshBootstrapTask({
        ...(props.runner ? { runner: props.runner } : {}),
        relayUrl: props.relayUrl,
        webappUrl: props.webappUrl,
        publicRelayUrl: props.publicRelayUrl,
    });

    const items = React.useMemo(() => buildRemoteSshChecklistItems({
        mode: props.mode,
        installRelayRuntime,
    }), [installRelayRuntime, props.mode]);
    const planItems = React.useMemo(() => items.map(toPlanChecklistItem), [items]);
    const executionById = React.useMemo(() => mapRemoteSshTaskToChecklistExecution({
        snapshot: activeTaskSnapshot,
        items,
    }), [activeTaskSnapshot, items]);
    const planExecutionById = React.useMemo(() => {
        const result: Record<string, PlanChecklistExecutionState> = {};
        for (const [itemId, execution] of Object.entries(executionById)) {
            result[itemId] = toPlanExecutionState(execution as any);
        }
        return result;
    }, [executionById]);
    const relayRuntimeResult = React.useMemo(() => {
        if (!activeTaskSnapshot?.result?.ok) {
            return null;
        }
        const relayRuntime = (activeTaskSnapshot.result.data as {
            relayRuntime?: { relayUrl?: unknown };
        } | undefined)?.relayRuntime;
        const relayUrl = typeof relayRuntime?.relayUrl === 'string' ? relayRuntime.relayUrl.trim() : '';
        return relayUrl.length > 0 ? relayUrl : null;
    }, [activeTaskSnapshot]);

    React.useEffect(() => {
        if (phase !== 'execution' || phase === 'complete') {
            return;
        }
        if (activeTaskSnapshot?.result?.ok) {
            setPhase('complete');
            props.onCompleted?.({
                machineId: completedMachineId,
                relayRuntimeUrl: relayRuntimeResult,
                mode: props.mode,
            });
        }
    }, [activeTaskSnapshot?.result?.ok, completedMachineId, phase, props.mode, props.onCompleted, relayRuntimeResult]);

    const selectedItemIds = React.useMemo(() => getRemoteSshSelectedItemIds(items), [items]);

    const handleStartExecution = React.useCallback(async () => {
        setStartErrorMessage(null);
        resetPromptResolution();
        setPhase('execution');
        try {
            await start({
                sshUsername: draft.username.trim(),
                sshHost: draft.host.trim(),
                sshPort: draft.port.trim(),
                sshAuth: draft.authMode,
                sshPassword: draft.password,
                identityFilePath: draft.identityFilePath,
                installRelayRuntime,
            });
        } catch (error) {
            setStartErrorMessage(error instanceof Error ? error.message : 'Unable to start remote SSH setup.');
            setPhase('plan');
        }
    }, [draft, installRelayRuntime, resetPromptResolution, start]);

    const handleContinueAfterPrompt = React.useCallback(async () => {
        if (!prompt) return;
        if (prompt.kind === 'ssh.password') {
            await answerPasswordPrompt({
                sshUsername: draft.username.trim(),
                sshHost: draft.host.trim(),
                sshPort: draft.port.trim(),
                sshAuth: draft.authMode,
                sshPassword: draft.password,
                identityFilePath: draft.identityFilePath,
                installRelayRuntime,
            });
            return;
        }

        await continueAfterPrompt({
            sshUsername: draft.username.trim(),
            sshHost: draft.host.trim(),
            sshPort: draft.port.trim(),
            sshAuth: draft.authMode,
            sshPassword: draft.password,
            identityFilePath: draft.identityFilePath,
            installRelayRuntime,
        });
    }, [answerPasswordPrompt, continueAfterPrompt, draft, installRelayRuntime, prompt]);

    const handleToggleItem = React.useCallback((itemId: string) => {
        if (itemId === 'install_relay_runtime' && props.mode === 'remoteRelayHost') {
            setInstallRelayRuntime((current) => !current);
        }
    }, [props.mode]);

    const handleToggleExpandedItem = React.useCallback((itemId: string) => {
        setExpandedItemId((current) => current === itemId ? null : itemId);
    }, []);

    const handleCopyDiagnostics = React.useCallback(async (itemId: string) => {
        const item = items.find((entry) => entry.id === itemId);
        const execution = executionById[itemId];
        if (!item || !execution) {
            return;
        }

        const lines = [
            `Remote SSH checklist diagnostics (${props.mode})`,
            `Item: ${item.title}`,
            `Status: ${execution.status}`,
            item.details,
            ...execution.logs,
            execution.errorMessage ? `Error: ${execution.errorMessage}` : null,
        ].filter((line): line is string => Boolean(line && line.trim().length > 0));

        try {
            await Clipboard.setStringAsync(lines.join('\n'));
        } catch (error) {
            await Modal.alert(t('common.error'), error instanceof Error ? error.message : 'Unable to copy diagnostics.');
        }
    }, [executionById, items, props.mode]);

    const promptBlock = React.useMemo(() => {
        if (!prompt) {
            return null;
        }

        if (prompt.kind === 'ssh.password') {
            return (
                <View style={styles.promptCard}>
                    <Text style={styles.promptTitle}>Enter SSH password</Text>
                    <Text style={styles.promptBody}>{prompt.message}</Text>
                    <View style={{ gap: 10 }}>
                        <RoundButton
                            title={t('common.continue')}
                            onPress={() => void handleContinueAfterPrompt()}
                            loading={isStarting}
                        />
                        <RoundButton
                            title={t('common.cancel')}
                            display="inverted"
                            onPress={() => dismissPrompt()}
                        />
                    </View>
                </View>
            );
        }

        return (
            <View style={styles.promptCard}>
                <Text style={styles.promptTitle}>
                    {prompt.kind === 'auth.approveRemoteProvisioning'
                        ? 'Approve remote provisioning'
                        : 'Trust SSH host'}
                </Text>
                <Text style={styles.promptBody}>{prompt.message}</Text>
                <Text style={styles.promptBody}>
                    {prompt.kind === 'auth.approveRemoteProvisioning'
                        ? prompt.publicKey ?? 'No public key provided.'
                        : `${prompt.host}\n${prompt.fingerprint}${prompt.existingFingerprint ? `\n${prompt.existingFingerprint}` : ''}`}
                </Text>
                <View style={{ gap: 10 }}>
                    <RoundButton
                        title={prompt.kind === 'auth.approveRemoteProvisioning' ? 'Approve' : 'Trust and continue'}
                        onPress={() => void handleContinueAfterPrompt()}
                        loading={isStarting}
                    />
                    <RoundButton
                        title={t('common.cancel')}
                        display="inverted"
                        onPress={() => dismissPrompt()}
                    />
                </View>
            </View>
        );
    }, [dismissPrompt, handleContinueAfterPrompt, isStarting, prompt, styles.promptBody, styles.promptCard, styles.promptTitle]);

    React.useLayoutEffect(() => {
        props.onWizardPrimaryChange?.(null);
        props.onWizardBackChange?.(null);
        props.onWizardSkipChange?.(null);

        if (!props.onWizardPrimaryChange) {
            return;
        }

        if (phase === 'credentials') {
            props.onWizardPrimaryChange({
                label: t('common.continue'),
                disabled: !isDraftReady(draft),
                onPress: () => setPhase('plan'),
            });
            return;
        }

        if (phase === 'plan') {
            props.onWizardBackChange?.({
                onPress: () => setPhase('credentials'),
            });
            props.onWizardPrimaryChange({
                label: t('common.continue'),
                disabled: false,
                onPress: async () => {
                    await handleStartExecution();
                },
            });
            return;
        }

        if (phase === 'complete') {
            props.onWizardBackChange?.({ hidden: true });
            props.onWizardSkipChange?.({ hidden: true });
            props.onWizardPrimaryChange({
                label: t('common.continue'),
                disabled: false,
                onPress: props.onRequestAdvance ?? (() => undefined),
            });
            return;
        }

        // execution
        props.onWizardBackChange?.({ hidden: true });
        props.onWizardSkipChange?.({ hidden: true });
        if (activeTaskSnapshot?.result && !activeTaskSnapshot.result.ok) {
            props.onWizardPrimaryChange({
                label: t('common.retry'),
                disabled: isStarting,
                onPress: async () => {
                    await handleStartExecution();
                },
            });
            return;
        }
        props.onWizardPrimaryChange({
            label: t('common.continue'),
            disabled: true,
            onPress: () => undefined,
        });
    }, [
        activeTaskSnapshot?.result,
        draft,
        handleStartExecution,
        isStarting,
        phase,
        props.onRequestAdvance,
        props.onWizardBackChange,
        props.onWizardPrimaryChange,
        props.onWizardSkipChange,
    ]);

    React.useEffect(() => () => {
        props.onWizardPrimaryChange?.(null);
        props.onWizardBackChange?.(null);
        props.onWizardSkipChange?.(null);
    }, [props.onWizardBackChange, props.onWizardPrimaryChange, props.onWizardSkipChange]);

    if (phase === 'complete' && activeTaskSnapshot?.result?.ok) {
        return (
            <View testID={props.testID} style={styles.root}>
                <View style={styles.heading}>
                    <Text style={styles.title}>Remote machine ready</Text>
                    <Text style={styles.subtitle}>
                        {relayRuntimeResult
                            ? `Relay runtime installed: ${relayRuntimeResult}`
                            : 'Remote machine setup finished successfully.'}
                    </Text>
                </View>
            </View>
        );
    }

    if (phase === 'credentials') {
        return (
            <View testID={props.testID} style={styles.root}>
                <View style={styles.heading}>
                    <Text style={styles.title}>
                        {props.mode === 'remoteRelayHost' ? 'Set up a remote relay host' : 'Set up a remote machine'}
                    </Text>
                    <Text style={styles.subtitle}>
                        {props.mode === 'remoteRelayHost'
                            ? 'Use SSH to install the relay runtime and connect the machine.'
                            : 'Use SSH to install Happier on the remote machine and connect it to your account.'}
                    </Text>
                </View>

                <WizardSshCredentialsFields
                    testIDPrefix={props.testID ? `${props.testID}-ssh` : 'remote-ssh-checklist-ssh'}
                    testIdStyle="settings"
                    value={draft}
                    onChange={setDraft}
                />
            </View>
        );
    }

    if (phase === 'plan') {
        return (
            <View testID={props.testID} style={styles.root}>
                <View style={styles.heading}>
                    <Text style={styles.title}>Review the setup plan</Text>
                    <Text style={styles.subtitle}>
                        {props.mode === 'remoteRelayHost'
                            ? 'This plan installs the remote CLI, configures the relay, and installs the relay runtime.'
                            : 'This plan installs the remote CLI, configures the relay, and installs the background service.'}
                    </Text>
                </View>

                <PlanChecklistCard
                    testID={props.testID ? `${props.testID}-plan` : 'remote-ssh-checklist-plan'}
                    phase="select"
                    items={planItems}
                    selectedIds={selectedItemIds}
                    expandedId={expandedItemId}
                    onToggleItem={handleToggleItem}
                    onToggleExpanded={handleToggleExpandedItem}
                />
                {startErrorMessage ? (
                    <Text style={styles.promptBody}>{startErrorMessage}</Text>
                ) : null}
            </View>
        );
    }

    return (
        <View testID={props.testID} style={styles.root}>
            <View style={styles.heading}>
                <Text style={styles.title}>Setting up the remote machine</Text>
                <Text style={styles.subtitle}>The checklist below updates as the remote bootstrap runs.</Text>
            </View>

            {startErrorMessage ? (
                <Text style={styles.subtitle}>{startErrorMessage}</Text>
            ) : null}

            <PlanChecklistCard
                testID={props.testID ? `${props.testID}-execution` : 'remote-ssh-checklist-execution'}
                phase="execute"
                items={planItems}
                executionById={planExecutionById}
                selectedIds={selectedItemIds}
                expandedId={expandedItemId}
                onToggleExpanded={handleToggleExpandedItem}
                onCopyDiagnostics={(item) => void handleCopyDiagnostics(item.id)}
            />

            {promptBlock}

            {activeTaskSnapshot && activeTaskSnapshot.result && !activeTaskSnapshot.result.ok ? (
                <Text style={styles.subtitle}>The remote bootstrap failed. Review the checklist details and retry.</Text>
            ) : null}
        </View>
    );
});
