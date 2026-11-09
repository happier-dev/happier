import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SessionTerminalMemberV1, SessionTerminalTabV1 } from '@happier-dev/protocol/terminal/workspace';

import { Modal } from '@/modal';
import { buildCommandSurfaceCardChrome, COMMAND_SURFACE_WEB_PLACEMENT } from '@/modal/components/card/commandSurfaceCard';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import { SelectionList } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import {
    describeSessionTerminal,
    describeSessionTerminalTab,
    type SessionTerminalDescribeContext,
} from '@/components/sessions/terminal/presentation/describeSessionTerminal';
import type { TerminalSurfaceSummary } from '@/components/sessions/terminal/terminalSurfaceSummary';
import { buildTerminalJumpModel } from '@/components/sessions/terminal/jump/terminalJumpSections';
import { useTerminalJumpScopeChrome } from '@/components/sessions/terminal/jump/useTerminalJumpScopeChrome';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { t } from '@/text';

/**
 * Dev-only specimen of Jump to a terminal (terminal lab B4 / B4q / B4p) with the lab's data. The QA
 * stack has no daemon, so the live sources are replaced at their boundary: the pane layout, each
 * terminal's last-known summary and the daemon's list of other sessions' PTYs are fixtures. Rows,
 * groups, wording and status come from the real owners (`describeSessionTerminal`,
 * `buildTerminalJumpModel`), drawn by the real palette list in the real command-surface card with the
 * same scope chip the palette uses. Activation is a no-op here.
 */
const CONTEXT: SessionTerminalDescribeContext = {
    agentId: 'claude',
    agentName: 'Claude',
    agentAsking: true,
    agentTerminalHost: 'tmux',
    sessionMachineId: 'machine-mbp',
    sessionMachineName: 'MacBook Pro',
    machineName: (id) => ({ 'machine-mbp': 'MacBook Pro', 'machine-devbox': 'devbox' })[id] ?? null,
};

const MEMBERS: Readonly<Record<string, SessionTerminalMemberV1>> = {
    claude: { id: 'claude', target: { kind: 'session_attach' } },
    zsh: { id: 'zsh', target: { kind: 'workspace_shell' } },
    vite: { id: 'vite', target: { kind: 'workspace_shell', launch: { kind: 'package_script', runTargetId: 'vite:dev' } } },
    storybook: { id: 'storybook', target: { kind: 'workspace_shell', launch: { kind: 'package_script', runTargetId: 'storybook:dev' } } },
    devbox: { id: 'devbox', target: { kind: 'machine_shell', machineId: 'machine-devbox', cwd: '~/' } },
};

const SUMMARIES: Readonly<Record<string, TerminalSurfaceSummary>> = {
    zsh: { title: 'zsh', bell: null, status: 'connected', error: null, failure: null, url: null },
    vite: { title: 'vite', bell: null, status: 'connected', error: null, failure: null, url: 'http://localhost:5173/' },
    storybook: { title: 'storybook', bell: null, status: 'connected', error: null, failure: null, url: 'http://localhost:6006/' },
    'key-craft-vite': { title: 'vite', bell: null, status: 'connected', error: null, failure: null, url: 'http://localhost:5174/' },
    'key-review-test': { title: 'test', bell: null, status: 'exited', error: null, failure: null, url: null },
};

function layoutTab(id: string, members: readonly string[]): SessionTerminalTabV1 {
    return {
        id,
        terminals: members.map((member) => MEMBERS[member]!),
        focusedTerminalId: members[0]!,
        root: members.length === 1 ? { kind: 'leaf', terminalId: members[0]! }
            : { kind: 'split', id: `${id}-split`, ratio: 0.5, first: { kind: 'leaf', terminalId: members[0]! }, second: { kind: 'leaf', terminalId: members[1]! } },
    };
}

const WORKSPACE_TABS: readonly SessionTerminalTabV1[] = [
    layoutTab('claude', ['claude']),
    { ...layoutTab('zsh', ['zsh']), terminals: [{ ...MEMBERS.zsh!, title: 'zsh' }] },
    layoutTab('servers', ['vite', 'storybook']),
    layoutTab('devbox', ['devbox']),
];

const SCRIPTS = [{
    id: 'package:ui:vitest', source: 'package_script', machineId: 'machine-mbp', title: 'vitest', confidence: 'medium', state: 'available', actions: ['start'],
    commandPreview: 'yarn vitest',
    sourceClass: { kind: 'package_script', runTargetId: 'ui-vitest', packageName: 'ui', scriptName: 'vitest', cwd: '/Users/leeroy/happier/apps/ui' },
}] as unknown as readonly LocalServiceLaunchTarget[];

const ZSH_DETAIL = 'yarn test settings --watch';

function useSpecimenModel(query: string) {
    return React.useMemo(() => {
        const tabs = WORKSPACE_TABS.map((tab) => describeSessionTerminalTab(tab, tab.terminals.map((member) => {
            const described = describeSessionTerminal(member, SUMMARIES[member.id] ?? null, CONTEXT);
            // The shell's own title names it; its second line is the command it last ran.
            return member.id === 'zsh' ? { ...described, detail: ZSH_DETAIL } : described;
        })));
        return buildTerminalJumpModel({
            tabs,
            workspaceTabs: WORKSPACE_TABS,
            activeTabId: 'zsh',
            sessionId: 'session-specimen',
            ownTerminalKeys: new Set(),
            machineId: 'machine-mbp',
            machineName: 'MacBook Pro',
            folderName: 'happier',
            others: {
                status: 'ready',
                terminals: [
                    { terminalId: 'craft-vite', terminalKey: 'key-craft-vite', cwd: '/Users/leeroy/happier', sessionId: 'session-craft', ended: false, exit: null },
                    { terminalId: 'review-test', terminalKey: 'key-review-test', cwd: '/Users/leeroy/happier', sessionId: 'session-review', ended: true, exit: { exitCode: 1, signal: null } },
                ],
            },
            readSummary: (key) => SUMMARIES[key] ?? null,
            readSessionName: (id) => ({ 'session-craft': 'Craft pass lab', 'session-review': 'Review #2481' })[id] ?? id,
            scripts: SCRIPTS,
        }, query);
    }, [query]);
}

export type TerminalJumpSpecimenModalProps = CustomModalInjectedProps & Readonly<{ initialQuery?: string }>;

export function TerminalJumpSpecimenModal(props: TerminalJumpSpecimenModalProps): React.ReactElement {
    const title = t('terminalWorkspace.jump.title');
    const chrome = React.useMemo(() => buildCommandSurfaceCardChrome({ title, testID: 'universal-search:modal' }), [title]);
    useModalCardChrome(props.setChrome, chrome);
    const [query, setQuery] = React.useState(props.initialQuery ?? '');
    const [scoped, setScoped] = React.useState(true);
    const model = useSpecimenModel(query);
    const scope = useTerminalJumpScopeChrome(scoped, () => setScoped(false));
    return (
        <View style={styles.root} testID="universal-search-host">
            <SelectionList
                rootStep={model.step}
                selectionMark="enter"
                inputValue={query}
                onChangeInputValue={setQuery}
                onSelect={() => props.onClose()}
                onRequestClose={props.onClose}
                listAccessibilityLabel={title}
                filters={scope.filters}
                inputBehavior={scope.inputBehavior}
                autoFocusInputOnWeb
                fillAvailableSpace
            />
        </View>
    );
}

/** The page behind the palette: the line opens the specimen (the modal host owns when it can show). */
export function TerminalJumpSpecimen(props: Readonly<{ initialQuery?: string }>): React.ReactElement {
    const open = React.useCallback(() => {
        Modal.show({
            component: TerminalJumpSpecimenModal,
            webPlacement: COMMAND_SURFACE_WEB_PLACEMENT,
            props: { ...(props.initialQuery ? { initialQuery: props.initialQuery } : {}) },
        });
    }, [props.initialQuery]);
    return (
        <View style={styles.page}>
            <Text onPress={open}>{t('terminalWorkspace.jump.title')}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, minHeight: 0, width: '100%' },
    page: { flex: 1, padding: 24, backgroundColor: theme.colors.background.canvas },
}));
