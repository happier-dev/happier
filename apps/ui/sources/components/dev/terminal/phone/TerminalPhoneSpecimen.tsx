import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SessionTerminalMemberV1, SessionTerminalTabV1, SessionTerminalWorkspaceV1 } from '@happier-dev/protocol/terminal/workspace';

import { SessionTerminalPageView } from '@/components/sessions/panes/terminal/SessionTerminalPage';
import {
    describeSessionTerminalTabs,
    type SessionTerminalDescribeContext,
    type SessionTerminalDescriptor,
} from '@/components/sessions/terminal/presentation/describeSessionTerminal';
import { reduceSessionTerminalWorkspace } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import type { TerminalSurfaceSummary } from '@/components/sessions/terminal/terminalSurfaceSummary';
import { SessionPaneHeader } from '@/components/sessions/shell/view/SessionPaneHeader';
import { EmbeddedTerminalPane } from '@/components/terminal/embedded/EmbeddedTerminalPane';
import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import type { EmbeddedTerminalPaneController, EmbeddedTerminalPaneStatus } from '@/components/terminal/embedded/types';
import { randomUUID } from '@/platform/randomUUID';
import { writeTerminalArrowPadPlacement } from '@/components/terminal/embedded/keys/terminalArrowPadState';

/**
 * Dev-only: the phone Terminal page (terminal lab P1, P1c, P1m, A1p, B2p, STp) drawn through the real
 * `SessionTerminalPageView` chips, the real embedded pane (frame, xterm renderer, key rail, arrow pad)
 * and the real terminal-workspace reducer. The QA stack has no daemon, so each terminal is a fixture
 * controller that writes the lab's output into the real renderer; tapping chips only moves this
 * specimen's local layout. Nothing reaches a machine.
 */
type Variant = 'P1' | 'P1c' | 'P1m' | 'A1p' | 'B2p' | 'STp';
const VARIANTS: readonly Variant[] = ['P1', 'P1c', 'P1m', 'A1p', 'B2p', 'STp'];

const P = '\u001b[1;34m~/happier\u001b[0m \u001b[35mon v0.3 ↑2\u001b[0m';
const $ = '\u001b[32m$\u001b[0m';
const OUTPUT: Readonly<Record<string, string>> = {
    zsh: [
        `${P}`, `${$} git status --short`,
        ' \u001b[33mM\u001b[0m …/settings/modal/SettingsModal.tsx',
        ' \u001b[33mM\u001b[0m …/settings/modal/SettingsModal.test.tsx',
        '\u001b[32m??\u001b[0m …/settings/modal/useSettingsRouteKey.ts',
        `${P}`, `${$} `,
    ].join('\r\n'),
    vite: [
        `${P}`, `${$} yarn workspace @happier-dev/ui dev`, '',
        '  \u001b[1;32mVITE v6.2.1\u001b[0m  ready in \u001b[1m812 ms\u001b[0m', '',
        '  \u001b[32m➜\u001b[0m  \u001b[1mLocal\u001b[0m:   \u001b[4;34mhttp://localhost:5173/\u001b[0m',
        '  \u001b[2m➜  Network: use --host to expose\u001b[0m', '',
        '\u001b[2m10:41:07 [vite]\u001b[0m hmr update /components/settings/modal/SettingsModal.tsx',
        '\u001b[2m10:42:30 [vite]\u001b[0m hmr update /components/settings/modal/SettingsModal.tsx',
        '\u001b[2m10:44:02 [vite]\u001b[0m page reload app/(app)/settings.tsx',
    ].join('\r\n'),
    claude: [
        '\u001b[38;5;209m●\u001b[0m I’ll run the settings end-to-end tests to make sure the modal keeps its state.', '',
        '\u001b[1mBash command\u001b[0m', '',
        '  yarn test:e2e --filter settings',
        '  \u001b[2mRun the settings end-to-end tests\u001b[0m', '',
        'Do you want to proceed?',
        '\u001b[38;5;75m❯ 1. Yes\u001b[0m',
        '  2. Yes, and don’t ask again for',
        '     \u001b[1myarn test:e2e\u001b[0m in ~/happier',
        '  3. No, and tell Claude what to do',
        '     differently \u001b[2m(esc)\u001b[0m',
    ].join('\r\n'),
};

const leaf = (id: string) => ({ kind: 'leaf' as const, terminalId: id });
const MEMBERS: Readonly<Record<string, SessionTerminalMemberV1>> = {
    claude: { id: 'claude', target: { kind: 'session_attach' } },
    zsh: { id: 'zsh', target: { kind: 'workspace_shell' } },
    vite: { id: 'vite', target: { kind: 'workspace_shell', launch: { kind: 'package_script', runTargetId: 'vite:dev' } } },
};
const single = (id: string): SessionTerminalTabV1 => ({ id, terminals: [MEMBERS[id]!], focusedTerminalId: id, root: leaf(id) });

function buildWorkspace(variant: Variant): SessionTerminalWorkspaceV1 {
    if (variant === 'B2p') {
        return {
            v: 1, showList: false, activeTabId: 'zsh',
            tabs: [single('claude'), {
                id: 'zsh', terminals: [MEMBERS.zsh!, MEMBERS.vite!], focusedTerminalId: 'zsh',
                root: { kind: 'split', id: 'split-1', ratio: 0.5, first: leaf('zsh'), second: leaf('vite') },
            }],
        };
    }
    const active = variant === 'A1p' ? 'claude' : variant === 'P1m' ? 'vite' : 'zsh';
    return { v: 1, showList: false, activeTabId: active, tabs: [single('claude'), single('zsh'), single('vite')] };
}

const SUMMARIES: Readonly<Record<string, TerminalSurfaceSummary>> = {
    claude: { title: null, bell: null, status: 'connected', error: null, failure: null, url: null },
    zsh: { title: 'zsh', bell: null, status: 'connected', error: null, failure: null, url: null },
    vite: { title: 'vite', bell: null, status: 'connected', error: null, failure: null, url: 'http://localhost:5173/' },
};

function buildContext(variant: Variant): SessionTerminalDescribeContext {
    return {
        agentId: 'claude', agentName: 'Claude', agentAsking: variant === 'A1p', agentTerminalHost: 'tmux',
        sessionMachineId: 'macbook', sessionMachineName: 'MacBook Pro',
        machineName: (id) => (id === 'macbook' ? 'MacBook Pro' : null),
    };
}

const PLACEMENTS: Readonly<Record<Variant, { side: 'left' | 'right'; y: number; tucked: boolean } | null>> = {
    P1: null, A1p: null, B2p: null, STp: null,
    P1c: { side: 'right', y: 0.86, tucked: true },
    P1m: { side: 'left', y: 0.5, tucked: false },
};

const NOOP = () => undefined;

function FixtureTerminal(props: Readonly<{ member: SessionTerminalMemberV1; descriptor: SessionTerminalDescriptor; status: EmbeddedTerminalPaneStatus; error: string | null }>) {
    const terminalRef = React.useRef<EmbeddedTerminalRendererHandle | null>(null);
    const written = React.useRef(false);
    const controller = React.useMemo((): EmbeddedTerminalPaneController => ({
        status: props.status,
        error: props.error,
        detectedUrl: null,
        onInput: NOOP,
        onPaste: NOOP,
        onResize: NOOP,
        onReady: () => {
            if (written.current) return;
            written.current = true;
            terminalRef.current?.write(OUTPUT[props.member.id] ?? '');
        },
        onWriteComplete: NOOP,
        clearTerminal: NOOP,
        requestRestart: NOOP,
        retryConnect: NOOP,
        dismissDetectedUrl: NOOP,
    }), [props.error, props.member.id, props.status]);
    return (
        <EmbeddedTerminalPane
            title={props.descriptor.title}
            chrome="none"
            machineName="MacBook Pro"
            controller={controller}
            terminalRef={terminalRef}
            testIdPrefix="terminal-phone"
            nativeSurfaceKey={`specimen:${props.member.id}`}
            showQuickKeys
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.base },
}));

export function TerminalPhoneSpecimen(props: Readonly<{ variant: string | null }>) {
    const variant: Variant = VARIANTS.find((item) => item === props.variant) ?? 'P1';
    const [workspace, setWorkspace] = React.useState(() => buildWorkspace(variant));
    React.useEffect(() => {
        setWorkspace(buildWorkspace(variant));
        // The pad's resting place is device-local; the specimen stages each variant's.
        writeTerminalArrowPadPlacement('portrait', PLACEMENTS[variant]);
    }, [variant]);
    const context = React.useMemo(() => buildContext(variant), [variant]);
    const tabs = React.useMemo(() => describeSessionTerminalTabs(workspace.tabs,
        workspace.tabs.flatMap((tab) => tab.terminals.map((member) => SUMMARIES[member.id] ?? null)), context),
    [context, workspace.tabs]);
    const onAction = React.useCallback((actionId: string, input: Readonly<Record<string, unknown>>) => {
        setWorkspace((current) => {
            if (actionId === 'session.terminals.focus') return reduceSessionTerminalWorkspace(current, { type: 'focus', terminalId: String(input.terminalId) });
            if (actionId === 'session.terminals.close_tab') return reduceSessionTerminalWorkspace(current, { type: 'closeTab', tabId: String(input.tabId) });
            const id = randomUUID();
            return reduceSessionTerminalWorkspace(current, { type: 'open', terminal: { id, target: { kind: 'workspace_shell' } } });
        });
    }, []);
    const offline = variant === 'STp';
    const renderTerminal = React.useCallback((member: SessionTerminalMemberV1, descriptor: SessionTerminalDescriptor) => (
        <FixtureTerminal
            key={member.id}
            member={member}
            descriptor={descriptor}
            status={offline ? 'error' : 'connected'}
            error={offline ? 'terminal_machine_unreachable' : null}
        />
    ), [offline]);
    return (
        <View style={styles.root}>
            <SessionPaneHeader title="Fix settings modal remount" subtitle="happier · MacBook Pro" onBackPress={NOOP} />
            <SessionTerminalPageView
                key={variant}
                workspace={workspace}
                tabs={tabs}
                context={context}
                onAction={onAction}
                renderTerminal={renderTerminal}
                testIdPrefix="terminal-phone"
            />
        </View>
    );
}
