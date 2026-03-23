import * as React from 'react';

import { resolveCodeEditorFontMetrics } from '@/components/ui/code/editor/codeEditorFontMetrics';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { XtermTerminalView, type XtermTerminalHandle } from '@/components/terminal/xterm/XtermTerminalView.web';
import type { EmbeddedTerminalRendererHandle } from '@/components/sessions/terminal/embeddedTerminalRendererHandle';
import { EmbeddedTerminalPaneFrame } from './EmbeddedTerminalPaneFrame';
import type { EmbeddedTerminalPaneController } from './types';

export type EmbeddedTerminalPaneProps = Readonly<{
    title: string;
    controller: EmbeddedTerminalPaneController;
    terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
    onRequestClose?: (() => void) | null;
    toolbarActionsStart?: React.ReactNode;
    testIdPrefix?: string | null;
    showQuickKeys?: boolean;
}>;

export const EmbeddedTerminalPane = React.memo(function EmbeddedTerminalPaneWeb(props: EmbeddedTerminalPaneProps) {
    const uiFontScale = useLocalSetting('uiFontScale');
    const fontMetrics = React.useMemo(() => resolveCodeEditorFontMetrics({ uiFontScale }), [uiFontScale]);
    const xtermRef = props.terminalRef as React.MutableRefObject<XtermTerminalHandle | null>;

    return (
        <EmbeddedTerminalPaneFrame
            title={props.title}
            controller={props.controller}
            onRequestClose={props.onRequestClose}
            toolbarActionsStart={props.toolbarActionsStart}
            testIdPrefix={props.testIdPrefix}
            platformOS="web"
            surface={(
                <XtermTerminalView
                    testID={props.testIdPrefix ? `${props.testIdPrefix}-xterm` : undefined}
                    ref={xtermRef}
                    fontSize={fontMetrics.fontSize}
                    onInput={props.controller.onInput}
                    onResize={props.controller.onResize}
                    onReady={props.controller.onReady}
                />
            )}
        />
    );
});

export default EmbeddedTerminalPane;
