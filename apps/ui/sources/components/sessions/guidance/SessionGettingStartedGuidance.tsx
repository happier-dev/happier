import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useVisibleSessionListViewData } from '@/hooks/session/useVisibleSessionListViewData';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { useMachineListByServerId, useMachineListStatusByServerId, useSetting } from '@/sync/domains/state/storage';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';

import type { SessionGettingStartedDecisionKind } from './gettingStartedModel';
import type { SessionGettingStartedViewModel } from './gettingStartedModel';
import { buildSessionGettingStartedViewModel } from './gettingStartedModel';
import { Text } from '@/components/ui/text/Text';


export type SessionGettingStartedGuidanceVariant = 'phone' | 'sidebar' | 'primaryPane' | 'newSessionBlocking';

const SESSION_GETTING_STARTED_GUIDANCE_FEATURE_ID = 'app.ui.sessionGettingStartedGuidance' as const satisfies FeatureId;

export type SessionGettingStartedGuidanceViewModel = Readonly<{
    kind: SessionGettingStartedDecisionKind;
    targetLabel: string;
    serverUrl: string;
    serverName: string;
    showServerSetup: boolean;
    onStartNewSession?: () => void;
    onConnectTerminal?: () => void;
    onEnterUrlManually?: () => void;
    connectIsLoading?: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    scrollContainer: {
        flex: 1,
        width: '100%',
    },
    contentContainer: {
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'flex-start',
        paddingHorizontal: 20,
        paddingTop: 32,
        paddingBottom: 20,
    },
    title: {
        width: '100%',
        maxWidth: 720,
        gap: 28,
        marginTop: 10,
        fontSize: 22,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        width: '100%',
        maxWidth: 720,
        gap: 28,
        marginBottom: 16,
        fontSize: 16,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    terminalText: {
        ...Typography.mono(),
        fontSize: 15,
        color: theme.colors.status.connected,
    },
    stepsContainer: {
        width: '100%',
        maxWidth: 720,
        gap: 28,
    },
    stepHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 10,
    },
    stepTitle: {
        fontSize: 16,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    stepDescription: {
        marginTop: 2,
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
        maxWidth: 560,
    },
    stepTextCol: {
        flex: 1,
        flexBasis: 0,
    },
    codeBlock: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
    },
    codeText: {
        flex: 1,
        flexBasis: 0,
    },
    codeCopyButton: {
        marginTop: 1,
    },
    buttonsContainer: {
        alignItems: 'center',
        width: '100%',
        marginTop: 20,
        gap: 12,
    },
    buttonWrapper: {
        width: 260,
    },
}));

function titleForKind(kind: SessionGettingStartedDecisionKind): string {
    switch (kind) {
        case 'connect_machine':
            return 'Connect a machine';
        case 'start_daemon':
            return 'Start the daemon';
        case 'create_session':
            return 'Create a session';
        case 'select_session':
            return 'Select a session';
        case 'loading':
        default:
            return 'Loading…';
    }
}

function subtitleForKind(kind: SessionGettingStartedDecisionKind, targetLabel: string): string {
    switch (kind) {
        case 'connect_machine':
            return `To start sessions on ${targetLabel}, connect the Happier daemon on your computer (install it once to keep it always-on).`;
        case 'start_daemon':
            return `Your machines for ${targetLabel} look offline. Start the daemon on your computer, then try again.`;
        case 'create_session':
            return `Start a new session with the + button, or from your terminal.`;
        case 'select_session':
            return `Pick a session from the sidebar to view it here.`;
        case 'loading':
        default:
            return `Fetching your machines and sessions…`;
    }
}

function normalizeCommandLine(line: string): string {
    const trimmedStart = line.trimStart();
    if (!trimmedStart.startsWith('$')) return line;
    return trimmedStart.replace(/^\$\s*/, '');
}

type SessionGettingStartedGuidanceStep = Readonly<{
    id: string;
    title: string;
    description?: string;
    command?: string;
    copyLabel?: string;
}>;

function buildSteps(model: SessionGettingStartedGuidanceViewModel): SessionGettingStartedGuidanceStep[] {
    switch (model.kind) {
        case 'connect_machine': {
            const steps: SessionGettingStartedGuidanceStep[] = [];
            steps.push({
                id: 'install_cli',
                title: 'Install the CLI',
                description: 'Run this once on the machine you want to connect.',
                command: normalizeCommandLine(t('components.emptyMainScreen.installCommand')),
                copyLabel: 'Install command',
            });
            if (model.showServerSetup) {
                steps.push({
                    id: 'server_setup',
                    title: 'Set the default server',
                    description: 'One-time, so the next commands target the right server.',
                    command: `happier server add --name \"${model.serverName}\" --server-url \"${model.serverUrl}\" --use`,
                    copyLabel: 'Server setup',
                });
            }
            steps.push({
                id: 'auth_login',
                title: 'Sign in',
                description: 'This prints a QR / link to connect your terminal to your account.',
                command: 'happier auth login',
                copyLabel: 'Auth login',
            });
            steps.push({
                id: 'daemon_install',
                title: 'Install the daemon (recommended)',
                description: 'Keeps Happier always-on in the background for remote starts.',
                command: 'happier daemon install',
                copyLabel: 'Daemon install',
            });
            steps.push({
                id: 'create_session',
                title: 'Create a session',
                description: 'Use the + button in the app, or run one of these from your terminal.',
                command: ['happier', 'happier codex', 'happier opencode'].join('\n'),
                copyLabel: 'Create session',
            });
            return steps;
        }
        case 'start_daemon': {
            return [
                {
                    id: 'daemon_install',
                    title: 'Install the daemon (recommended)',
                    description: 'Installs an always-on user service and starts it.',
                    command: 'happier daemon install',
                    copyLabel: 'Daemon install',
                },
                {
                    id: 'daemon_start',
                    title: 'Start once (without installing)',
                    description: 'Use this if you only need it running right now.',
                    command: 'happier daemon start',
                    copyLabel: 'Daemon start',
                },
            ];
        }
        case 'create_session': {
            return [
                {
                    id: 'start_session',
                    title: 'Start a session from your computer',
                    description: 'Or use the + button in the app.',
                    command: 'happier',
                    copyLabel: 'Start session',
                },
            ];
        }
        case 'select_session':
        case 'loading':
        default: {
            return [];
        }
    }
}

async function copyTextToClipboard(params: Readonly<{ label: string; text: string }>): Promise<void> {
    try {
        await Clipboard.setStringAsync(params.text);
        Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: params.label }));
    } catch {
        Modal.alert(t('common.error'), t('textSelection.failedToCopy'));
    }
}

export function SessionGettingStartedGuidanceView(props: Readonly<{
    variant: SessionGettingStartedGuidanceVariant;
    model: SessionGettingStartedGuidanceViewModel;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { model } = props;

    const title = titleForKind(model.kind);
    const subtitle = subtitleForKind(model.kind, model.targetLabel);
    const steps = buildSteps(model);

    return (
        <ScrollView
            testID="session-getting-started-scroll"
            style={styles.scrollContainer}
            contentContainerStyle={styles.contentContainer}
            keyboardShouldPersistTaps="handled"
        >
            <View testID={`session-getting-started-kind-${model.kind}`} style={{ width: 0, height: 0, overflow: 'hidden' }} />
            
            {steps.length > 0 ? (
                <View style={styles.stepsContainer}>
                    {steps.map((step) => (
                        <View key={step.id} testID={`session-getting-started-step-${step.id}`}>
                            <View style={styles.stepHeader}>
                                <View style={styles.stepTextCol}>
                                    <Text style={styles.stepTitle}>{step.title}</Text>
                                    {step.description ? <Text style={styles.stepDescription}>{step.description}</Text> : null}
                                </View>
                            </View>
                            {step.command ? (
                                <View style={styles.codeBlock}>
                                    <Text style={[styles.terminalText, styles.codeText]}>{step.command}</Text>
                                    <Pressable
                                        testID={`session-getting-started-copy-${step.id}`}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Copy ${step.copyLabel ?? 'command'}`}
                                        style={styles.codeCopyButton}
                                        onPress={() => copyTextToClipboard({ label: step.copyLabel ?? 'Command', text: step.command ?? '' })}
                                    >
                                        <Ionicons name="copy-outline" size={16} color={theme.colors.textSecondary} />
                                    </Pressable>
                                </View>
                            ) : null}
                        </View>
                    ))}
                </View>
            ) : null}

            <View style={styles.buttonsContainer}>
                {model.kind === 'create_session' && model.onStartNewSession ? (
                    <View style={styles.buttonWrapper}>
                        <RoundButton
                            testID="session-getting-started-start-new-session"
                            title={t('components.emptySessionsTablet.startNewSessionButton')}
                            onPress={model.onStartNewSession}
                            size="normal"
                        />
                    </View>
                ) : null}

                {props.variant === 'phone' && Platform.OS !== 'web' && model.onConnectTerminal ? (
                    <View style={styles.buttonWrapper}>
                        <RoundButton
                            title={t('components.emptyMainScreen.openCamera')}
                            onPress={model.onConnectTerminal}
                            loading={Boolean(model.connectIsLoading)}
                            size="normal"
                        />
                    </View>
                ) : null}

                {props.variant === 'phone' && model.onEnterUrlManually ? (
                    <View style={styles.buttonWrapper}>
                        <RoundButton
                            title={t('connect.enterUrlManually')}
                            onPress={model.onEnterUrlManually}
                            loading={Boolean(model.connectIsLoading)}
                            size="normal"
                            display={Platform.OS === 'web' ? undefined : 'inverted'}
                        />
                    </View>
                ) : null}
            </View>
        </ScrollView>
    );
}

export function useSessionGettingStartedGuidanceBaseModel(): SessionGettingStartedViewModel {
    const sessions = useVisibleSessionListViewData();
    const selection = useResolvedActiveServerSelection();
    const serverSelectionGroups = useSetting('serverSelectionGroups');
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();

    return React.useMemo(() => {
        return buildSessionGettingStartedViewModel({
            sessions,
            selection,
            serverSelectionGroups,
            serverProfiles: listServerProfiles().map((p) => ({ id: p.id, name: p.name, serverUrl: p.serverUrl })),
            machineListByServerId,
            machineListStatusByServerId,
        });
    }, [machineListByServerId, machineListStatusByServerId, selection, serverSelectionGroups, sessions]);
}

function SessionGettingStartedGuidanceEnabled(props: Readonly<{ variant: SessionGettingStartedGuidanceVariant }>): React.ReactElement {
    const router = useRouter();
    const baseModel = useSessionGettingStartedGuidanceBaseModel();

    const onStartNewSession = React.useCallback(() => {
        router.push('/new' as any);
    }, [router]);

    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();

    const onEnterUrlManually = React.useCallback(async () => {
        const url = await Modal.prompt(
            t('modals.authenticateTerminal'),
            t('modals.pasteUrlFromTerminal'),
            {
                placeholder: t('connect.terminalUrlPlaceholder'),
                cancelText: t('common.cancel'),
                confirmText: t('common.authenticate'),
            },
        );
        if (url?.trim()) {
            connectWithUrl(url.trim());
        }
    }, [connectWithUrl]);

    const viewModel: SessionGettingStartedGuidanceViewModel = {
        kind: baseModel.kind,
        targetLabel: baseModel.targetLabel,
        serverUrl: baseModel.serverUrl,
        serverName: baseModel.serverName,
        showServerSetup: baseModel.showServerSetup,
        ...(baseModel.kind === 'create_session' || baseModel.kind === 'select_session' ? { onStartNewSession } : {}),
        ...(props.variant === 'phone'
            ? {
                onConnectTerminal: connectTerminal,
                onEnterUrlManually,
                connectIsLoading: isLoading,
            }
            : {}),
    };

    return <SessionGettingStartedGuidanceView variant={props.variant} model={viewModel} />;
}

export function SessionGettingStartedGuidance(props: Readonly<{ variant: SessionGettingStartedGuidanceVariant }>): React.ReactElement | null {
    if (getFeatureBuildPolicyDecision(SESSION_GETTING_STARTED_GUIDANCE_FEATURE_ID) === 'deny') {
        return null;
    }
    return <SessionGettingStartedGuidanceEnabled variant={props.variant} />;
}
