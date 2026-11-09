import * as React from 'react';
import type { SessionTerminalMemberV1, SessionTerminalWorkspaceV1 } from '@happier-dev/protocol/terminal/workspace';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PANE_SIZING_DEFAULTS } from '@/components/appShell/panes/layout/paneSizing';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import {
    describeSessionTerminalTabs,
    type SessionTerminalDescribeContext,
} from '@/components/sessions/terminal/presentation/describeSessionTerminal';
import type { TerminalSurfaceSummary } from '@/components/sessions/terminal/terminalSurfaceSummary';
import {
    buildSessionTerminalNewMenuItems,
    buildSessionTerminalPaneMenuItems,
    buildSessionTerminalTabMenuItems,
    TERMINAL_MENU_GLYPH_PX,
} from '@/components/sessions/terminal/strip/sessionTerminalMenus';
import { SessionTerminalWorkspaceView } from '@/components/sessions/terminal/strip/SessionTerminalWorkspaceView';
import { reduceSessionTerminalWorkspace } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { EmbeddedTerminalPane } from '@/components/terminal/embedded/EmbeddedTerminalPane';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import type { EmbeddedTerminalPaneController, EmbeddedTerminalPaneStatus } from '@/components/terminal/embedded/types';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { buildKeyboardShortcutLabels, resolveKeyboardPlatform } from '@/keyboard/runtime';

/**
 * Dev-only specimen of the session bottom pane (terminal lab B1/B2/B3/A1/L/M/ST) drawn through the real
 * `SessionTerminalWorkspaceView`, menus, descriptors and `EmbeddedTerminalPane` (xterm) with the lab's
 * output written into the real renderer. There is no daemon behind it: each terminal's controller is a
 * local stand-in that reports a fixed status, so states can be captured frame by frame.
 */

const ESC = '\u001b[';
const c = (code: string, text: string) => `${ESC}${code}m${text}${ESC}0m`;
const PROMPT = `${c('1;34', '~/happier')} ${c('35', 'on v0.3 ↑2')}`;
const OUTPUT: Record<string, string> = {
    zsh: [
        PROMPT, `${c('1;32', '$')} yarn test settings --watch`, '',
        ` ${c('32', '✓')} sources/components/settings/modal/SettingsModal.test.tsx ${c('2', '(18 tests) 412ms')}`,
        ` ${c('32', '✓')} sources/components/settings/modal/useSettingsRouteKey.test.ts ${c('2', '(6 tests) 38ms')}`, '',
        ` ${c('2', 'Test Files')}  ${c('1;32', '2 passed')} ${c('2', '(2)')}`,
        `      ${c('2', 'Tests')}  ${c('1;32', '24 passed')} ${c('2', '(24)')}`,
        `   ${c('2', 'Start at')}  10:42:31`,
        `   ${c('2', 'Duration')}  1.38s`, '',
        ` ${c('7', ' PASS ')} ${c('2', 'Waiting for file changes… press')} h ${c('2', 'to show help,')} q ${c('2', 'to quit')}`,
        `${c('1;32', '$')} `,
    ].join('\r\n'),
    zshShort: [
        PROMPT, `${c('1;32', '$')} git status --short`,
        ` ${c('33', 'M')} …/settings/modal/SettingsModal.tsx`,
        ` ${c('33', 'M')} …/settings/modal/SettingsModal.test.tsx`,
        `${c('32', '??')} …/settings/modal/useSettingsRouteKey.ts`,
        PROMPT, `${c('1;32', '$')} `,
    ].join('\r\n'),
    vite: [
        PROMPT, `${c('1;32', '$')} yarn workspace @happier-dev/ui dev`, '',
        `  ${c('32', 'VITE v6.2.1')}  ready in ${c('1', '812 ms')}`, '',
        `  ${c('32', '➜')}  ${c('1', 'Local')}:   ${c('4;34', 'http://localhost:5173/')}`,
        `  ${c('2', '➜  Network: use --host to expose')}`, '',
        `${c('2', '10:41:07 [vite]')} hmr update /components/settings/modal/SettingsModal.tsx`,
        `${c('2', '10:42:30 [vite]')} hmr update /components/settings/modal/SettingsModal.tsx`,
        `${c('2', '10:44:02 [vite]')} page reload app/(app)/settings.tsx`,
    ].join('\r\n'),
    claude: [
        `${c('1;38;5;173', '●')} I’ll run the settings end-to-end tests to make sure the modal keeps its state.`, '',
        c('38;5;173', '╭──────────────────────────────────────────────────────────────╮'),
        `${c('38;5;173', '│')} ${c('1;38;5;173', 'Bash command')}                                                 ${c('38;5;173', '│')}`,
        `${c('38;5;173', '│')}                                                              ${c('38;5;173', '│')}`,
        `${c('38;5;173', '│')}   yarn test:e2e --filter settings                            ${c('38;5;173', '│')}`,
        `${c('38;5;173', '│')}   ${c('2', 'Run the settings end-to-end tests')}                          ${c('38;5;173', '│')}`,
        `${c('38;5;173', '│')}                                                              ${c('38;5;173', '│')}`,
        `${c('38;5;173', '│')} Do you want to proceed?                                      ${c('38;5;173', '│')}`,
        `${c('38;5;173', '│')} ${c('1;38;5;173', '❯ 1. Yes')}                                                     ${c('38;5;173', '│')}`,
        `${c('38;5;173', '│')}   2. Yes, and don't ask again for ${c('1', 'yarn test:e2e')} in ~/happier   ${c('38;5;173', '│')}`,
        `${c('38;5;173', '│')}   3. No, and tell Claude what to do differently ${c('2', '(esc)')}         ${c('38;5;173', '│')}`,
        c('38;5;173', '╰──────────────────────────────────────────────────────────────╯'),
        c('2', '  » ask before edits · shift+tab to cycle'),
    ].join('\r\n'),
    typecheck: [
        PROMPT, `${c('1;32', '$')} yarn typecheck`,
        c('31', 'sources/settings/modal/SettingsModal.tsx(14,9): error TS2345'),
        c('2', 'Found 1 error. Watching for file changes.'), '^C',
        c('2', '[process exited with code 1]'),
    ].join('\r\n'),
};

type FixtureTerminal = Readonly<{ member: SessionTerminalMemberV1; output: string; summary: TerminalSurfaceSummary }>;
const summary = (status: EmbeddedTerminalPaneStatus, extra: Partial<TerminalSurfaceSummary> = {}): TerminalSurfaceSummary => {
    const error = extra.error ?? null;
    const failure = extra.failure ?? (status === 'error'
        ? error === 'terminal_machine_unreachable' ? 'machine-unreachable' : 'failed'
        : null);
    return { title: null, bell: null, status, error, failure, url: null, ...extra };
};
const term = (id: string, member: Omit<SessionTerminalMemberV1, 'id'>, output: string, s: TerminalSurfaceSummary): FixtureTerminal => ({ member: { id, ...member }, output, summary: s });

const TERMINALS: Record<string, FixtureTerminal> = {
    claude: term('claude', { target: { kind: 'session_attach' } }, OUTPUT.claude!, summary('connected')),
    zsh: term('zsh', { target: { kind: 'workspace_shell' }, title: 'zsh' }, OUTPUT.zsh!, summary('connected', { title: 'yarn test settings --watch' })),
    zshShort: term('zsh', { target: { kind: 'workspace_shell' }, title: 'zsh' }, OUTPUT.zshShort!, summary('connected')),
    vite: term('vite', { target: { kind: 'workspace_shell', launch: { kind: 'package_script', runTargetId: 'vite:dev' } }, title: 'vite' }, OUTPUT.vite!, summary('connected', { url: 'http://localhost:5173/' })),
    storybook: term('storybook', { target: { kind: 'workspace_shell', launch: { kind: 'package_script', runTargetId: 'storybook:dev' } }, title: 'storybook' }, OUTPUT.vite!, summary('connected', { url: 'http://localhost:6006/' })),
    devbox: term('devbox', { target: { kind: 'machine_shell', machineId: 'devbox', cwd: '~/' } }, OUTPUT.zshShort!, summary('connected')),
    exited: term('zsh', { target: { kind: 'workspace_shell' }, title: 'zsh' }, OUTPUT.typecheck!, summary('exited')),
    offline: term('zsh', { target: { kind: 'workspace_shell' }, title: 'zsh' }, OUTPUT.zsh!, summary('error', { error: 'terminal_machine_unreachable' })),
    failed: term('zsh', { target: { kind: 'workspace_shell' }, title: 'zsh' }, '', summary('error', { error: 'terminal_cwd_denied' })),
};

type Variant = Readonly<{
    tabs: readonly (readonly string[])[];
    active: number;
    showList?: boolean;
    agentAsking?: boolean;
    status?: Partial<Record<string, Readonly<{ status: EmbeddedTerminalPaneStatus; error?: string }>>>;
    heightPx?: number;
    newMenuOpen?: boolean;
}>;

const VARIANTS: Record<string, Variant> = {
    B1: { tabs: [['claude'], ['zsh'], ['vite']], active: 1 },
    B2: { tabs: [['claude'], ['zshShort', 'vite']], active: 1 },
    B3: { tabs: [['claude'], ['zsh'], ['vite', 'storybook'], ['devbox']], active: 1, showList: true, agentAsking: true },
    A1: { tabs: [['claude'], ['zsh'], ['vite']], active: 0, agentAsking: true },
    L: { tabs: [['claude'], ['zsh'], ['vite']], active: 2, heightPx: 300 },
    M: { tabs: [['claude'], ['zsh'], ['vite']], active: 1, newMenuOpen: true },
    exited: { tabs: [['claude'], ['exited'], ['vite']], active: 1, heightPx: 236, status: { zsh: { status: 'exited' } } },
    offline: { tabs: [['claude'], ['offline'], ['vite']], active: 1, heightPx: 236, status: { zsh: { status: 'error', error: 'terminal_machine_unreachable' } } },
    failed: { tabs: [['failed']], active: 0, heightPx: 236, status: { zsh: { status: 'error', error: 'terminal_cwd_denied' } } },
    bell: { tabs: [['claude'], ['zsh'], ['vite']], active: 2, heightPx: 236, agentAsking: true },
};

const CONTEXT = (agentAsking: boolean): SessionTerminalDescribeContext => ({
    agentId: 'claude',
    agentName: 'Claude',
    agentAsking,
    agentTerminalHost: 'tmux',
    sessionMachineId: 'mbp',
    sessionMachineName: 'MacBook Pro',
    machineName: (machineId) => (machineId === 'devbox' ? 'devbox' : machineId === 'mbp' ? 'MacBook Pro' : null),
});

function buildWorkspace(variant: Variant): SessionTerminalWorkspaceV1 {
    let workspace: SessionTerminalWorkspaceV1 = { v: 1, tabs: [], activeTabId: null, showList: variant.showList === true };
    for (const keys of variant.tabs) {
        const [first, ...rest] = keys.map((key) => TERMINALS[key]!.member);
        workspace = reduceSessionTerminalWorkspace(workspace, { type: 'open', terminal: first! });
        for (const member of rest) {
            workspace = reduceSessionTerminalWorkspace(workspace, { type: 'split', terminal: member, availableWidthPx: 1000, minimumTerminalWidthPx: 200 });
        }
        if (rest.length > 0) workspace = reduceSessionTerminalWorkspace(workspace, { type: 'focus', terminalId: first!.id });
    }
    const activeTab = workspace.tabs[variant.active];
    return activeTab ? reduceSessionTerminalWorkspace(workspace, { type: 'focus', terminalId: activeTab.focusedTerminalId }) : workspace;
}

/** A terminal leaf: the real pane and renderer, fed the lab's output once the renderer is ready. */
function FixtureTerminalLeaf(props: Readonly<{ fixture: FixtureTerminal; title: string; status: EmbeddedTerminalPaneStatus; error: string | null }>) {
    const terminalRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
    const wroteRef = React.useRef(false);
    const controller = React.useMemo((): EmbeddedTerminalPaneController => ({
        status: props.status,
        error: props.error,
        detectedUrl: null,
        onInput: () => {},
        onPaste: () => {},
        onResize: () => {},
        onReady: () => {
            if (wroteRef.current) return;
            wroteRef.current = true;
            terminalRef.current?.write(props.fixture.output);
        },
        onWriteComplete: () => {},
        clearTerminal: () => {},
        requestRestart: () => {},
        retryConnect: () => {},
        dismissDetectedUrl: () => {},
    }), [props.error, props.fixture.output, props.status]);
    return (
        <EmbeddedTerminalPane
            title={props.title}
            chrome="none"
            machineName="MacBook Pro"
            controller={controller}
            terminalRef={terminalRef}
            testIdPrefix={`terminal-specimen-${props.fixture.member.id}`}
        />
    );
}

export function TerminalWorkspaceSpecimen(props: Readonly<{ variant: string | null }>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const variant = VARIANTS[props.variant ?? 'B1'] ?? VARIANTS.B1!;
    const shortcuts = React.useMemo(() => buildKeyboardShortcutLabels(resolveKeyboardPlatform(), 'web'), []);
    const [workspace, setWorkspace] = React.useState(() => buildWorkspace(variant));
    const [newMenuOpen, setNewMenuOpen] = React.useState(variant.newMenuOpen === true);
    const fixtures = React.useMemo(() => new Map(variant.tabs.flat().map((key) => [TERMINALS[key]!.member.id, TERMINALS[key]!])), [variant]);
    const context = React.useMemo(() => CONTEXT(variant.agentAsking === true), [variant.agentAsking]);
    const tabs = React.useMemo(() => describeSessionTerminalTabs(workspace.tabs,
        workspace.tabs.flatMap((tab) => tab.terminals.map((member) => fixtures.get(member.id)?.summary ?? null)), context),
    [context, fixtures, workspace.tabs]);

    const glyph = React.useCallback((name: IconName) => <Icon name={name} size={TERMINAL_MENU_GLYPH_PX} color={theme.colors.text.secondary} />, [theme.colors.text.secondary]);
    const newMenuItems = React.useMemo(() => buildSessionTerminalNewMenuItems({
        folder: 'happier',
        shellShortcut: shortcuts['terminal.newShell'],
        machineName: 'MacBook Pro',
        agent: { agentId: 'claude', name: 'Claude', available: true, unavailableReason: null },
        scripts: [
            { id: 'docs', title: 'docs:dev', command: 'yarn docs:dev' },
            { id: 'e2e', title: 'test:e2e', command: 'yarn test:e2e' },
        ],
        machines: [
            { id: 'devbox', name: 'devbox', online: true, cwd: '~/', lastSeen: null },
            { id: 'studio', name: 'Studio', online: false, cwd: null, lastSeen: null },
        ],
    }, glyph, (agentId) => <AgentIcon agentId={agentId} size={TERMINAL_MENU_GLYPH_PX} />), [glyph, shortcuts]);
    const paneMenuItems = React.useMemo(() => buildSessionTerminalPaneMenuItems({ showList: workspace.showList, canJump: true, jumpShortcut: shortcuts['terminal.jump'], hideShortcut: shortcuts['terminal.toggle'], canOpenSettings: false }, glyph), [glyph, shortcuts, workspace.showList]);
    const tabMenuItems = React.useCallback((tabId: string) => {
        const tab = workspace.tabs.find((candidate) => candidate.id === tabId);
        const descriptor = tabs.find((candidate) => candidate.tabId === tabId);
        return tab && descriptor ? buildSessionTerminalTabMenuItems({
            tab: descriptor, terminalId: tab.focusedTerminalId,
            mounted: { copySelection: true, paste: true, clear: true, restart: true },
            canSplit: true, canOpenInDetails: true, hasOtherTabs: workspace.tabs.length > 1,
            splitShortcut: shortcuts['terminal.split'],
        }, glyph) : [];
    }, [glyph, shortcuts, tabs, workspace.tabs]);

    const focus = React.useCallback((terminalId: string) => setWorkspace((current) => reduceSessionTerminalWorkspace(current, { type: 'focus', terminalId })), []);
    const renderLeaf = React.useCallback((member: SessionTerminalMemberV1, state: Readonly<{ descriptor: { title: string } | null }>) => {
        const fixture = fixtures.get(member.id);
        if (!fixture) return null;
        const status = variant.status?.[member.id];
        return <FixtureTerminalLeaf fixture={fixture} title={state.descriptor?.title ?? member.id} status={status?.status ?? 'connected'} error={status?.error ?? null} />;
    }, [fixtures, variant.status]);

    return (
        <View style={styles.canvas}>
            <View style={styles.above} />
            <View style={[styles.pane, { height: variant.heightPx ?? 330 }]} testID="terminal-specimen-pane">
                <SessionTerminalWorkspaceView
                    scopeId="session:terminal-specimen"
                    workspace={workspace}
                    tabs={tabs}
                    renderLeaf={renderLeaf}
                    minimumTerminalWidthPx={PANE_SIZING_DEFAULTS.mainMinPx}
                    onActivateTab={(tabId) => { const tab = workspace.tabs.find((candidate) => candidate.id === tabId); if (tab) focus(tab.focusedTerminalId); }}
                    onFocusTerminal={focus}
                    onCloseTab={(tabId) => setWorkspace((current) => reduceSessionTerminalWorkspace(current, { type: 'closeTab', tabId }))}
                    onResize={(command) => setWorkspace((current) => reduceSessionTerminalWorkspace(current, command))}
                    onNewShell={() => {}}
                    newMenuOpen={newMenuOpen}
                    onNewMenuOpenChange={setNewMenuOpen}
                    newMenuItems={newMenuItems}
                    onNewMenuSelect={() => {}}
                    canSplit
                    onSplit={() => {}}
                    tabMenuItems={tabMenuItems}
                    onTabMenuSelect={() => {}}
                    paneMenuItems={paneMenuItems}
                    onPaneMenuSelect={(itemId) => { if (itemId === 'showList') setWorkspace((current) => ({ ...current, showList: !current.showList })); }}
                    onHide={() => {}}
                    onOpenUrl={() => {}}
                    testIdPrefix="terminal-specimen"
                />
            </View>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    canvas: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
        justifyContent: 'flex-end',
    },
    above: {
        flex: 1,
    },
    pane: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
}));
