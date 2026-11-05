import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierBodyEdgeContext, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import type { MachineAgentSignInSession } from '@/agents/machineAgents/machineAgentTypes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export type AgentSignInTerminalHandlers = Readonly<{
    onOpenUrl: (url: string) => void;
    onCheckAgain: () => void;
    onStartSession?: () => void;
    onClose: () => void;
}>;

export type AgentSignInTerminalViewProps = Readonly<{
    agentTitle: string;
    mark: React.ReactNode;
    machineName: string;
    session: MachineAgentSignInSession;
    /** Signed in: the account the agent's own probe reported, when it names one. */
    accountLabel: string | null;
    /** The live machine terminal running the agent's own login (the container mounts it). */
    terminal: React.ReactNode;
    /** `pane`: the bottom pane beside the terminal (wide). `sheet`: a phone sheet, the link first and the terminal behind a disclosure. */
    layout: 'pane' | 'sheet';
    handlers: AgentSignInTerminalHandlers;
    testID: string;
}>;

/**
 * The agent's own sign-in, in the app's terminal (lab T1): the real CLI on the machine, and beside it the
 * waiting → signed-in moment — the link it printed (Open), a live "Waiting for sign-in…" with elapsed time
 * and Check again — until the agent's own status probe says signed in (T1b). On a phone the same pieces
 * stack as a sheet (T1p): the link as the primary action, the terminal behind a disclosure.
 */
export const AgentSignInTerminalView = React.memo(function AgentSignInTerminalView(props: AgentSignInTerminalViewProps) {
    if (props.layout === 'sheet') return <SignInSheet {...props} />;
    return (
        <View testID={props.testID} style={styles.pane}>
            <View style={styles.terminal}>{props.terminal}</View>
            <View style={styles.side} accessibilityLiveRegion="polite">
                <SidePanel {...props} />
            </View>
        </View>
    );
});

function SidePanel(props: AgentSignInTerminalViewProps) {
    const { theme } = useUnistyles();
    const { session, handlers, testID } = props;
    if (session.phase === 'signedIn') {
        return (
            <>
                <View style={styles.head}>
                    <Icon name="check-circle" size={16} color={theme.colors.state.success.foreground} />
                    <Text style={styles.title}>{t('machineAgents.readyLine', { agent: props.agentTitle, machine: props.machineName })}</Text>
                </View>
                <Text style={styles.lead}>
                    {[props.accountLabel ? t('machineAgents.panelSignedInAs', { account: props.accountLabel }) : null, t('machineAgents.panelChecked')].filter(Boolean).join(' ')}
                </Text>
                <View style={styles.grow} />
                <View style={styles.actions}>
                    {handlers.onStartSession ? (
                        <RoundButton testID={`${testID}.startSession`} size="small" title={t('machineAgents.startSession')} onPress={handlers.onStartSession} />
                    ) : null}
                    <RoundButton testID={`${testID}.close`} size="small" display="inverted" title={t('machineAgents.closeTerminal')} onPress={handlers.onClose} />
                </View>
            </>
        );
    }
    return (
        <>
            <View style={styles.head}>
                {props.mark}
                <Text style={styles.title}>{t('machineAgents.signInTitle', { agent: props.agentTitle })}</Text>
            </View>
            {/* A failed start opened no browser; a failed check after one did. */}
            {session.phase !== 'failed' || session.authUrl ? <Text style={styles.lead}>{t('machineAgents.panelLead')}</Text> : null}
            {session.authUrl ? <AuthUrl url={session.authUrl} onOpen={handlers.onOpenUrl} testID={testID} /> : null}
            {session.phase === 'failed' ? (
                <SignInFailureLine failure={session.failure} onCheckAgain={handlers.onCheckAgain} testID={testID} />
            ) : (
                <>
                    <WaitingLine startedAtMs={session.startedAtMs} />
                    <View style={styles.grow} />
                    <View style={styles.actions}>
                        <Text style={styles.quiet}>{t('machineAgents.signedInAlready')}</Text>
                        <RoundButton testID={`${testID}.checkAgain`} size="small" display="inverted" title={t('machineAgents.checkAgain')} onPress={handlers.onCheckAgain} />
                    </View>
                </>
            )}
        </>
    );
}

function SignInSheet(props: AgentSignInTerminalViewProps) {
    const { theme } = useUnistyles();
    const { session, handlers, testID } = props;
    const [terminalShown, setTerminalShown] = React.useState(false);
    return (
        <View testID={testID} style={styles.sheet} accessibilityLiveRegion="polite">
            <View style={styles.head}>
                {session.phase === 'signedIn'
                    ? <Icon name="check-circle" size={20} color={theme.colors.state.success.foreground} />
                    : props.mark}
                <Text style={styles.sheetTitle}>
                    {session.phase === 'signedIn'
                        ? t('machineAgents.readyLine', { agent: props.agentTitle, machine: props.machineName })
                        : t('machineAgents.signInTitle', { agent: props.agentTitle })}
                </Text>
            </View>
            {session.phase === 'signedIn' ? (
                <>
                    {props.accountLabel ? <Text style={styles.sheetLead}>{t('machineAgents.panelSignedInAs', { account: props.accountLabel })}</Text> : null}
                    {handlers.onStartSession ? (
                        <RoundButton testID={`${testID}.startSession`} title={t('machineAgents.startSession')} onPress={handlers.onStartSession} />
                    ) : null}
                </>
            ) : (
                <>
                    <Text style={styles.sheetLead}>{t('machineAgents.phoneLead', { agent: props.agentTitle, machine: props.machineName })}</Text>
                    {session.authUrl ? (
                        <RoundButton testID={`${testID}.openUrl`} title={t('machineAgents.openSignInPage')} onPress={() => handlers.onOpenUrl(session.authUrl!)} />
                    ) : null}
                    {session.phase === 'failed'
                        ? <SignInFailureLine failure={session.failure} onCheckAgain={handlers.onCheckAgain} testID={testID} />
                        : <WaitingLine startedAtMs={session.startedAtMs} />}
                </>
            )}
            <ExpandableItem
                testID={`${testID}.terminalDisclosure`}
                expanded={terminalShown}
                onExpandedChange={setTerminalShown}
                showDivider={false}
                header={({ headerProps }) => (
                    <Item {...headerProps} title={t('machineAgents.showTheTerminal')} icon={<Icon name="terminal" />} showChevron={false} />
                )}
            >
                <View style={styles.sheetTerminal}>{terminalShown ? props.terminal : null}</View>
            </ExpandableItem>
        </View>
    );
}

/** One cause, one line, one next step, on the panel's own text edge. */
function SignInFailureLine(props: Readonly<{ failure: string | null | undefined; onCheckAgain: () => void; testID: string }>) {
    return (
        <HappierBodyEdgeContext.Provider value>
            <SurfaceStateCard
                testID={`${props.testID}.failure`}
                size="line"
                kind="error"
                title={props.failure ?? t('machineAgents.unknown')}
                action={{ label: t('machineAgents.checkAgain'), onPress: props.onCheckAgain, testID: `${props.testID}.checkAgain` }}
            />
        </HappierBodyEdgeContext.Provider>
    );
}

function AuthUrl(props: Readonly<{ url: string; onOpen: (url: string) => void; testID: string }>) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.url}>
            <Icon name="link" size={14} color={theme.colors.text.secondary} />
            <Text style={styles.urlText} numberOfLines={1}>{props.url.replace(/^https?:\/\//, '')}</Text>
            <RoundButton testID={`${props.testID}.openUrl`} size="small" display="secondary" title={t('machineAgents.open')} onPress={() => props.onOpen(props.url)} />
        </View>
    );
}

/** "Waiting for sign-in… 0:37" — the clock ticks in this leaf only. */
function WaitingLine(props: Readonly<{ startedAtMs: number | null }>) {
    const { theme } = useUnistyles();
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        if (props.startedAtMs === null) return;
        const timer = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, [props.startedAtMs]);
    const elapsed = props.startedAtMs === null ? null : Math.max(0, Math.floor((now - props.startedAtMs) / 1000));
    return (
        <View style={styles.waiting}>
            <View style={[styles.pulse, { backgroundColor: theme.colors.accent.blue }]} />
            <Text style={styles.waitingText}>{t('machineAgents.waitingEllipsis')}</Text>
            <View style={styles.grow} />
            {elapsed !== null ? <Text style={styles.elapsed}>{`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    pane: {
        flex: 1,
        minHeight: 0,
        flexDirection: 'row',
    },
    terminal: {
        flex: 1,
        minWidth: 0,
    },
    side: {
        width: 300,
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderLeftColor: theme.colors.border.default,
        paddingHorizontal: theme.space.s16,
        paddingVertical: 14,
        gap: theme.space.s12,
    },
    head: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    title: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    lead: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
    quiet: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
    grow: {
        flexGrow: 1,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: theme.space.s8,
    },
    url: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s8,
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.strong,
    },
    urlText: {
        ...Typography.mono(),
        ...happierPageTextMetrics('rowDescription'),
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.secondary,
    },
    waiting: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    pulse: {
        width: 7,
        height: 7,
        borderRadius: 4,
    },
    waitingText: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.primary,
    },
    elapsed: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
    sheet: {
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s24,
    },
    sheetTitle: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    sheetLead: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowTitle'),
        color: theme.colors.text.secondary,
    },
    sheetTerminal: {
        height: 280,
    },
}));
