import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { DocumentTabStrip } from '@/components/ui/navigation/DocumentTabStrip';
import type { SessionTerminalMemberV1, SessionTerminalWorkspaceV1 } from '@happier-dev/protocol/terminal/workspace';
import type { SessionTerminalTabDescriptor } from '@/components/sessions/terminal/presentation/describeSessionTerminal';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/components/ui/popover', async importOriginal => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

const { SessionTerminalPageView } = await import('./SessionTerminalPage');
const { SessionTerminalWorkspaceView } = await import('@/components/sessions/terminal/strip/SessionTerminalWorkspaceView');

const tabs: readonly SessionTerminalTabDescriptor[] = [{ tabId: 'owned-elsewhere', title: 'Retained Shell', mark: { kind: 'shell' }, status: null,
    members: [{ terminalId: 'owned-elsewhere', title: 'Retained Shell', mark: { kind: 'shell' }, status: null, detail: null, place: null, url: null, borrowed: false }] }];
const workspace: SessionTerminalWorkspaceV1 = { v: 1, activeTabId: 'owned-elsewhere', showList: false,
    tabs: [{ id: 'owned-elsewhere', focusedTerminalId: 'owned-elsewhere', terminals: [{ id: 'owned-elsewhere', target: { kind: 'workspace_shell' } }], root: { kind: 'leaf', terminalId: 'owned-elsewhere' } }] };
const context = { agentId: null, agentName: null, agentAsking: false, agentTerminalHost: null,
    sessionMachineId: null, sessionMachineName: null, machineName: () => null };

describe('Terminal page renderer ownership', () => {
    afterEach(standardCleanup);
    it.each(['phone', 'desktop'] as const)('keeps four visited Shell instances mounted across %s tab activation', async device => {
        const mounts = new Map<string, number>();
        const unmounts: string[] = [];
        function TerminalInstance(props: Readonly<{ id: string }>) {
            React.useEffect(() => {
                mounts.set(props.id, (mounts.get(props.id) ?? 0) + 1);
                return () => { unmounts.push(props.id); };
            }, [props.id]);
            return React.createElement('TerminalInstance', { id: props.id });
        }
        const members = Array.from({ length: 4 }, (_, index) => ({ id: `shell-${index}`, target: { kind: 'workspace_shell' as const } }));
        const allTabs = members.map(member => ({ id: member.id, focusedTerminalId: member.id, terminals: [member], root: { kind: 'leaf' as const, terminalId: member.id } }));
        const descriptors = members.map(member => ({ ...tabs[0]!, tabId: member.id,
            members: [{ ...tabs[0]!.members[0]!, terminalId: member.id }] }));
        const leaf = (member: SessionTerminalMemberV1) => <TerminalInstance key={member.id} id={member.id} />;
        const render = (activeTabId: string, openTabs = allTabs) => {
            const current: SessionTerminalWorkspaceV1 = { v: 1, tabs: openTabs, activeTabId, showList: false };
            return device === 'phone'
                ? <SessionTerminalPageView workspace={current} tabs={descriptors} context={context}
                    onAction={() => {}} renderTerminal={leaf} testIdPrefix="retained" />
                : <SessionTerminalWorkspaceView scopeId="retained-four" workspace={current} tabs={descriptors}
                    renderLeaf={leaf} minimumTerminalWidthPx={320} onFocusTerminal={() => {}} onResize={() => {}}
                    onActivateTab={() => {}} onCloseTab={() => {}} onNewShell={() => {}}
                    newMenuOpen={false} onNewMenuOpenChange={() => {}} newMenuItems={[]} onNewMenuSelect={() => {}} canSplit={false}
                    onSplit={() => {}} tabMenuItems={() => []} onTabMenuSelect={() => {}} paneMenuItems={[]} onPaneMenuSelect={() => {}}
                    onHide={() => {}} onOpenUrl={() => {}} testIdPrefix="retained" />;
        };
        const screen = await renderScreen(render('shell-0'));
        expect([...mounts]).toEqual([['shell-0', 1]]); // Unvisited Shells do not start hidden work.
        for (const member of members.slice(1)) await screen.update(render(member.id));
        expect(unmounts).toEqual([]);
        const before = [...mounts];
        for (const member of [...members, ...members].reverse()) await screen.update(render(member.id));
        expect([...mounts]).toEqual(before);
        expect(unmounts).toEqual([]);
        await screen.update(render('shell-0', allTabs.filter(tab => tab.id !== 'shell-2')));
        expect(unmounts).toEqual(['shell-2']);
        await screen.unmount();
    });
    it.each(['phone', 'desktop'] as const)('keeps Shell discovery and New on %s without a second canvas when another host owns it', async device => {
        const invoked: string[] = [];
        const leaf = () => React.createElement('OwnedTerminalLeaf');
        const screen = await renderScreen(device === 'phone'
            ? <SessionTerminalPageView workspace={workspace} tabs={tabs} context={context} renderTerminals={false}
                onAction={action => { invoked.push(action); }} renderTerminal={leaf} testIdPrefix="elsewhere" />
            : <SessionTerminalWorkspaceView scopeId="page-presentation" workspace={workspace} tabs={tabs} renderTerminals={false}
                renderLeaf={leaf} minimumTerminalWidthPx={320} onFocusTerminal={() => { invoked.push('focus'); }} onResize={() => {}}
                onActivateTab={() => { invoked.push('focus'); }} onCloseTab={() => {}} onNewShell={() => { invoked.push('new'); }}
                newMenuOpen={false} onNewMenuOpenChange={() => {}} newMenuItems={[]} onNewMenuSelect={() => {}} canSplit={false}
                onSplit={() => {}} tabMenuItems={() => []} onTabMenuSelect={() => {}} paneMenuItems={[]} onPaneMenuSelect={() => {}}
                onHide={() => {}} onOpenUrl={() => {}} testIdPrefix="elsewhere" />);
        expect(screen.root.findAll(node => (node.type as unknown) === 'OwnedTerminalLeaf')).toHaveLength(0);
        expect(screen.findByTestId('elsewhere-list-row-owned-elsewhere')).toBeDefined();
        await act(async () => screen.findByType(DocumentTabStrip).props.onActivate('owned-elsewhere'));
        expect(invoked).toEqual([device === 'phone' ? 'session.terminals.focus' : 'focus']);
        expect(screen.findByTestId(device === 'phone' ? 'elsewhere-new-shell' : 'elsewhere-strip-new')).toBeDefined();
    });
    it.each(['phone', 'desktop'] as const)('says why a list of Shells stands in for the terminal when the host explains it (%s)', async device => {
        const note = 'These Shells are still running on devbox.';
        const leaf = () => React.createElement('OwnedTerminalLeaf');
        const screen = await renderScreen(device === 'phone'
            ? <SessionTerminalPageView workspace={workspace} tabs={tabs} context={context} renderTerminals={false} listNote={note}
                onAction={() => {}} renderTerminal={leaf} testIdPrefix="recovered" />
            : <SessionTerminalWorkspaceView scopeId="page-recovered" workspace={workspace} tabs={tabs} renderTerminals={false} listNote={note}
                renderLeaf={leaf} minimumTerminalWidthPx={320} onFocusTerminal={() => {}} onResize={() => {}}
                onActivateTab={() => {}} onCloseTab={() => {}} onNewShell={() => {}}
                newMenuOpen={false} onNewMenuOpenChange={() => {}} newMenuItems={[]} onNewMenuSelect={() => {}} canSplit={false}
                onSplit={() => {}} tabMenuItems={() => []} onTabMenuSelect={() => {}} paneMenuItems={[]} onPaneMenuSelect={() => {}}
                onHide={() => {}} onOpenUrl={() => {}} testIdPrefix="recovered" />);
        expect(screen.findByTestId('recovered-list-note')?.props.children).toBe(note);
        expect(screen.findByTestId('recovered-list-row-owned-elsewhere')).toBeDefined();
    });
});
