import * as React from 'react';

import type { CustomModalInjectedProps } from '@/modal/types';
import { buildCommandSurfaceCardChrome, type CommandSurfaceLayout } from '@/modal/components/card/commandSurfaceCard';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { Command } from '@/components/appShell/commandPalette/types';
import { t } from '@/text';
import { UniversalSearchController, type UniversalSearchControllerProps } from './UniversalSearchController';
import type { UniversalSearchScopeSeed, UniversalSearchSourceFocus } from './UniversalSearchRuntimeContext';
import type { TerminalJumpTarget } from '@/components/sessions/terminal/jump/terminalJumpTarget';

export type UniversalSearchModalProps = CustomModalInjectedProps & Readonly<{
    commands: readonly Command[];
    openWorkspaceFile?: UniversalSearchControllerProps['openWorkspaceFile'];
    symbols?: UniversalSearchControllerProps['symbols'];
    initialQuery?: string;
    initialSource?: UniversalSearchSourceFocus;
    initialReplace?: boolean;
    activeSessionId?: string | null;
    initialScope?: UniversalSearchScopeSeed;
    /** Open in the Terminals scope of this session pane (Jump to a terminal). */
    terminalJump?: TerminalJumpTarget;
}>;

export function UniversalSearchModal(props: UniversalSearchModalProps): React.ReactElement {
    const title = t('tools.names.search');
    // The controller says which frame it needs: compact for everything, wider with a detail column. Once wide,
    // the open card stays wide: leaving a detail scope (removing its chip) never narrows it under the pointer.
    const [layout, setLayout] = React.useState<CommandSurfaceLayout>('compact');
    const widenLayout = React.useCallback((next: CommandSurfaceLayout) => {
        setLayout(previous => (previous === 'detail' ? previous : next));
    }, []);
    // Spotlight: the command-surface card, with the search field as its top. Esc and the backdrop close it.
    const chrome = React.useMemo(() => buildCommandSurfaceCardChrome({
        title,
        testID: 'universal-search:modal',
        closeButtonTestID: 'universal-search:close',
        layout,
    }), [layout, title]);
    useModalCardChrome(props.setChrome, chrome);
    return (
        <UniversalSearchController
            commands={props.commands}
            openWorkspaceFile={props.openWorkspaceFile}
            symbols={props.symbols}
            initialQuery={props.initialQuery}
            initialSource={props.initialSource}
            initialReplace={props.initialReplace}
            activeSessionId={props.activeSessionId}
            initialScope={props.initialScope}
            terminalJump={props.terminalJump}
            presentation="modal"
            onSurfaceLayoutChange={widenLayout}
            onRequestClose={props.onClose}
        />
    );
}
