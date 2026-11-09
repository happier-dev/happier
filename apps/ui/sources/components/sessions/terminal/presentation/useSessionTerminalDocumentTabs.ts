import * as React from 'react';
import type { SessionTerminalWorkspaceV1 } from '@happier-dev/protocol/terminal/workspace';

import type { DocumentTabItem } from '@/components/ui/navigation/DocumentTabStrip';
import { t } from '@/text';

import type { SessionTerminalTabDescriptor } from './describeSessionTerminal';

export type SessionTerminalDocumentTab = DocumentTabItem & Pick<SessionTerminalTabDescriptor, 'mark' | 'status'>;

/** The strip needs title/mark/status, not each terminal's changing output and member facts. */
export function useSessionTerminalDocumentTabs(
    tabs: readonly SessionTerminalTabDescriptor[],
    workspace?: SessionTerminalWorkspaceV1,
): readonly SessionTerminalDocumentTab[] {
    const previousRows = React.useRef<readonly SessionTerminalDocumentTab[]>([]);
    const workspaceTabs = workspace?.tabs;
    return React.useMemo(() => {
        const previous = previousRows.current;
        const byKey = new Map(previous.map(tab => [tab.key, tab]));
        const models = workspaceTabs ? new Map(workspaceTabs.map(tab => [tab.id, tab])) : null;
        const next = tabs.map((tab): SessionTerminalDocumentTab => {
            const split = models !== null && tab.members.length > 1;
            const model = models?.get(tab.tabId);
            const index = split && model
                ? Math.max(0, model.terminals.findIndex(member => member.id === model.focusedTerminalId)) : 0;
            const row: SessionTerminalDocumentTab = {
                key: tab.tabId,
                // Phone chips name the half on screen; desktop tabs name the whole split.
                title: split ? tab.members[index]?.title ?? tab.title : tab.title,
                subtitle: split ? t('terminalWorkspace.keys.pagerA11y', { index: index + 1, count: tab.members.length }) : null,
                isPreview: false, isPinned: false, mark: tab.mark, status: tab.status,
            };
            const held = byKey.get(row.key);
            return held && held.title === row.title && held.subtitle === row.subtitle && held.status === row.status
                && held.mark.kind === row.mark.kind
                && (row.mark.kind !== 'agent' || (held.mark.kind === 'agent' && held.mark.agentId === row.mark.agentId))
                ? held : row;
        });
        previousRows.current = previous.length === next.length && next.every((tab, index) => tab === previous[index]) ? previous : next;
        return previousRows.current;
    }, [tabs, workspaceTabs]);
}
