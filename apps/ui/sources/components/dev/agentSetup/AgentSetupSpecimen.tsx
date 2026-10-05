import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { MachineAgent, MachineAgentSignInSession } from '@/agents/machineAgents/machineAgentTypes';
import { AgentSetupFormView, type AgentSetupFormHandlers } from '@/components/machines/agents/AgentSetupFormView';
import { AgentSignInTerminalView } from '@/components/machines/agents/AgentSignInTerminalView';
import { MachineAgentCard, MachineAgentCardGrid } from '@/components/machines/agents/MachineAgentCard';
import { MachineAgentMark } from '@/components/machines/agents/MachineAgentMark';
import { MachineAgentRow } from '@/components/machines/agents/MachineAgentRow';
import { MachineAgentsSectionView } from '@/components/machines/agents/MachineAgentsSectionView';
import { FirstAgentSetupBlock } from '@/components/machines/agents/FirstAgentSetupBlock';
import { MachineAgentSetupPaneView } from '@/components/machines/agents/MachineAgentSetupPane';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import {
    DEVBOX_AGENTS,
    FIXTURE_AGENTS,
    IDLE_SESSION,
    SIGNED_IN_SESSION,
    failedGemini,
    installingAntigravity,
    justInstalledGemini,
    readyAntigravity,
    waitingSession,
} from './agentSetupFixtures';

/**
 * Dev-only specimen of the agent-setup surfaces (lab `agent-setup`) drawn through the real components at
 * fixture props, for side by side pairs a dev Home cannot show (installs and sign-ins are never run on
 * real machines for a screenshot). `?frame=M1|M2|T1|T1b|T1p|S1|H1|H1p|E2|ST`. Never linked from product surfaces.
 */
export function AgentSetupSpecimen(props: Readonly<{ frame: string | null }>) {
    const frame = props.frame ?? 'M1';
    return (
        <View style={styles.page} testID={`agent-setup-specimen-${frame}`}>
            <SpecimenFrame frame={frame} />
        </View>
    );
}

const NOOP_HANDLERS: AgentSetupFormHandlers = {
    onInstall: () => {}, onCancelInstall: () => {}, onRetry: () => {}, onCheckAgain: () => {}, onOpenGuide: () => {},
    onUseService: () => {}, onConnectService: () => {}, onOpenNativeSignIn: () => {}, onShowTerminal: () => {},
    onCancelSignIn: () => {}, onStartSession: () => {}, onSetUpAnother: () => {},
};

const mark = (agent: MachineAgent, size = 20) => (
    <MachineAgentMark agentId={agent.agentId} machineId={null} serverId={null} size={size} />
);

function MachinePage(props: Readonly<{ children: React.ReactNode }>) {
    const { theme } = useUnistyles();
    return (
        <ItemList>
            <PageHeader
                testID="agent-setup-specimen.header"
                alwaysShowTitle
                title="devbox"
                description="Linux · x86_64 · online"
                leading={(
                    <PageHeaderMarkSlot>
                        <Icon name="desktop" size={22} color={theme.colors.text.secondary} />
                    </PageHeaderMarkSlot>
                )}
            />
            {props.children}
        </ItemList>
    );
}

function Section(props: Readonly<{
    agents: readonly MachineAgent[];
    expanded?: readonly string[];
    sessions?: Readonly<Record<string, MachineAgentSignInSession>>;
    status?: 'ready' | 'offline';
}>) {
    const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set(props.expanded ?? []));
    return (
        <MachineAgentsSectionView
            testID="agent-setup-specimen.section"
            agents={props.agents}
            status={props.status ?? 'ready'}
            lastCheckedAt={Date.now() - 12 * 60_000}
            machineName="devbox"
            renderMark={(agent) => mark(agent)}
            sessionFor={(agent) => props.sessions?.[agent.agentId] ?? IDLE_SESSION}
            renderForm={(agent) => (
                <AgentSetupFormView
                    testID={`agent-setup-specimen.form.${agent.agentId}`}
                    agent={agent}
                    machineName="devbox"
                    layout="full"
                    session={props.sessions?.[agent.agentId] ?? IDLE_SESSION}
                    handlers={NOOP_HANDLERS}
                />
            )}
            expandedAgentIds={expanded}
            onExpandedChange={(agentId, open) => setExpanded((current) => {
                const next = new Set(current);
                if (open) next.add(agentId); else next.delete(agentId);
                return next;
            })}
            onAction={() => {}}
            onCheckAgain={() => {}}
        />
    );
}

function FakeTerminal(props: Readonly<{ done: boolean }>) {
    const lines = [
        'leeroy@devbox:~$ agy   # opened by Happier to sign in',
        'Antigravity CLI 1.1.1',
        'You’re not signed in. Opening your browser…',
        'If it didn’t open, visit:',
        'https://accounts.google.com/o/oauth2/auth?client_id=agy…&code_challenge=…',
        props.done ? '✓ Signed in as leeroy@gmail.com' : 'Waiting for the browser…',
    ];
    return (
        <View style={styles.terminal}>
            {lines.map((line) => <Text key={line} style={styles.terminalLine}>{line}</Text>)}
        </View>
    );
}

function SpecimenFrame(props: Readonly<{ frame: string }>) {
    switch (props.frame) {
        case 'M2':
            return (
                <MachinePage>
                    <Section
                        agents={[FIXTURE_AGENTS.claude, FIXTURE_AGENTS.codex, FIXTURE_AGENTS.opencode, justInstalledGemini(), installingAntigravity(), FIXTURE_AGENTS.cursor]}
                        expanded={['gemini']}
                    />
                </MachinePage>
            );
        case 'T1':
        case 'T1b': {
            const done = props.frame === 'T1b';
            const antigravity = done ? readyAntigravity() : { ...readyAntigravity(), state: 'needsSignIn' as const, signIn: { ...FIXTURE_AGENTS.antigravity.signIn, status: 'signedOut' as const } };
            const session = done ? SIGNED_IN_SESSION : waitingSession();
            return (
                <View style={styles.split}>
                    <View style={styles.splitMain}>
                        <MachinePage>
                            <Section agents={[FIXTURE_AGENTS.claude, antigravity]} expanded={['antigravity']} sessions={{ antigravity: session }} />
                        </MachinePage>
                    </View>
                    <View style={styles.bottomPane}>
                        <AgentSignInTerminalView
                            testID="agent-setup-specimen.signIn"
                            layout="pane"
                            agentTitle="Antigravity"
                            mark={mark(FIXTURE_AGENTS.antigravity, 16)}
                            machineName="devbox"
                            session={session}
                            accountLabel={done ? 'leeroy@gmail.com' : null}
                            terminal={<FakeTerminal done={done} />}
                            handlers={{ onOpenUrl: () => {}, onCheckAgain: () => {}, onStartSession: () => {}, onClose: () => {} }}
                        />
                    </View>
                </View>
            );
        }
        case 'T1p':
            return (
                <AgentSignInTerminalView
                    testID="agent-setup-specimen.signInSheet"
                    layout="sheet"
                    agentTitle="Antigravity"
                    mark={mark(FIXTURE_AGENTS.antigravity, 22)}
                    machineName="devbox"
                    session={waitingSession()}
                    accountLabel={null}
                    terminal={<FakeTerminal done={false} />}
                    handlers={{ onOpenUrl: () => {}, onCheckAgain: () => {}, onClose: () => {} }}
                />
            );
        case 'S1':
            return (
                <ItemList>
                    <ItemGroup title="This computer" surface="none">
                        <MachineAgentCardGrid testID="agent-setup-specimen.cards">
                            {[FIXTURE_AGENTS.claude, { ...FIXTURE_AGENTS.codex, state: 'ready' as const }, FIXTURE_AGENTS.opencode].map((agent) => (
                                <MachineAgentCard key={agent.agentId} testID={`agent-setup-specimen.card.${agent.agentId}`} agent={agent} mark={mark(agent, 22)} onAction={() => {}} />
                            ))}
                        </MachineAgentCardGrid>
                    </ItemGroup>
                </ItemList>
            );
        case 'ST':
            return <StatesBoard />;
        case 'H1':
        case 'H1p': {
            const fresh = [FIXTURE_AGENTS.claude, FIXTURE_AGENTS.codex, FIXTURE_AGENTS.gemini, FIXTURE_AGENTS.opencode, FIXTURE_AGENTS.antigravity]
                .map((agent) => ({ ...agent, state: 'notInstalled' as const, installed: false, version: null, job: null, signIn: { ...agent.signIn, status: 'unknown' as const, via: null } }));
            return (
                <ItemList>
                    <ItemGroup title="Get set up" surface="none">
                        <FirstAgentSetupBlock
                            testID="agent-setup-specimen.first"
                            machineName="MacBook Pro"
                            agents={fresh}
                            phone={props.frame === 'H1p'}
                            renderMark={(agent) => mark(agent, 22)}
                            renderForm={(agent) => (
                                <AgentSetupFormView testID="agent-setup-specimen.first.form" agent={justInstalledGemini()} machineName="MacBook Pro" layout="compact" session={IDLE_SESSION} handlers={NOOP_HANDLERS} />
                            )}
                            onAllAgents={() => {}}
                            onDismiss={() => {}}
                        />
                    </ItemGroup>
                </ItemList>
            );
        }
        case 'E2':
            return (
                <View style={styles.enginePane}>
                    <MachineAgentSetupPaneView
                        agent={FIXTURE_AGENTS.antigravity}
                        machineName="devbox"
                        form={<AgentSetupFormView testID="agent-setup-specimen.e2.form" agent={FIXTURE_AGENTS.antigravity} machineName="devbox" layout="compact" session={IDLE_SESSION} handlers={NOOP_HANDLERS} />}
                    />
                </View>
            );
        case 'M1':
        default:
            return (
                <MachinePage>
                    <Section agents={DEVBOX_AGENTS} />
                </MachinePage>
            );
    }
}

function StatesBoard() {
    const rows: Array<[string, MachineAgent, MachineAgentSignInSession?]> = [
        ['Checking', { ...FIXTURE_AGENTS.opencode, state: 'checking' }],
        ['Installing', installingAntigravity()],
        ['Install failed', failedGemini()],
        ['Needs sign-in', FIXTURE_AGENTS.opencode],
        ['Waiting for sign-in', { ...FIXTURE_AGENTS.opencode, version: '1.1.1' }, waitingSession()],
        ['Update available', FIXTURE_AGENTS.codex],
        ['Signed in (connected service)', FIXTURE_AGENTS.claude],
        ['Unsupported here', { ...FIXTURE_AGENTS.antigravity, state: 'unsupported', platform: { supported: false, reason: 'arch' } }],
        ['Machine offline', { ...FIXTURE_AGENTS.claude, signIn: { ...FIXTURE_AGENTS.claude.signIn, via: { kind: 'native', accountLabel: null } }, stale: true }],
    ];
    const forms: Array<[string, MachineAgent, MachineAgentSignInSession?]> = [
        ['Ready to install', FIXTURE_AGENTS.antigravity],
        ['Installing', installingAntigravity()],
        ['Install failed', failedGemini()],
        ['Sign in: connected service first', justInstalledGemini()],
        ['Sign in: service not connected yet', { ...FIXTURE_AGENTS.opencode, signIn: { ...FIXTURE_AGENTS.opencode.signIn, connectedServices: [{ serviceId: 'openai-codex', title: 'ChatGPT subscription', connected: false, healthy: false, profileLabel: null }] } }],
        ['Unsupported on this machine', { ...FIXTURE_AGENTS.antigravity, state: 'unsupported', platform: { supported: false, reason: 'arch' } }],
    ];
    return (
        <ItemList>
            <ItemGroup title="Rows">
                {rows.map(([label, agent, session], index) => (
                    <MachineAgentRow key={label} testID={`agent-setup-specimen.row.${index}`} agent={agent} mark={mark(agent)} session={session ?? IDLE_SESSION} onAction={() => {}} showDivider={index < rows.length - 1} />
                ))}
            </ItemGroup>
            {forms.map(([label, agent, session]) => (
                <ItemGroup key={label} title={label}>
                    <View style={styles.formCell}>
                        <AgentSetupFormView testID={`agent-setup-specimen.stform.${label}`} agent={agent} machineName="devbox" layout="compact" session={session ?? IDLE_SESSION} handlers={NOOP_HANDLERS} />
                    </View>
                </ItemGroup>
            ))}
        </ItemList>
    );
}

const styles = StyleSheet.create((theme) => ({
    page: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
    },
    split: {
        flex: 1,
    },
    splitMain: {
        flex: 1,
        minHeight: 0,
    },
    bottomPane: {
        height: 318,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    terminal: {
        flex: 1,
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: theme.colors.surface.inset,
    },
    terminalLine: {
        ...Typography.mono(),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    formCell: {
        padding: 12,
    },
    enginePane: {
        width: 506,
        margin: 24,
        padding: 16,
    },
}));
