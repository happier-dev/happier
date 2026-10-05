import * as React from 'react';
import { View } from 'react-native';
import { useTerminalFind } from './useTerminalFind';

import { resolveCodeEditorFontMetrics } from '@/components/ui/code/editor/codeEditorFontMetrics';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { XtermTerminalView, type XtermTerminalHandle } from '@/components/terminal/xterm/XtermTerminalView.web';
import type { EmbeddedTerminalRendererHandle, EmbeddedTerminalCursorRow } from './embeddedTerminalRendererHandle';
import { useDeviceType } from '@/utils/platform/responsive';
import { EmbeddedTerminalPaneFrame } from './EmbeddedTerminalPaneFrame';
import { TerminalKeyRail } from './keys/TerminalKeyRail';
import { TerminalKeysSurface } from './keys/TerminalKeysSurface';
import { useTerminalKeys } from './keys/useTerminalKeys';
import type { EmbeddedTerminalPaneController } from './types';

export type EmbeddedTerminalPaneProps = Readonly<{
    title: string;
    controller: EmbeddedTerminalPaneController;
    terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
    onRequestClose?: (() => void) | null;
    toolbarActionsStart?: React.ReactNode;
    /** See `EmbeddedTerminalPaneFrame` `chrome`. */
    chrome?: 'toolbar' | 'none';
    machineName?: string | null;
    testIdPrefix?: string | null;
    nativeSurfaceKey?: string | null;
    showQuickKeys?: boolean;
    focused?: boolean;
    findSurfaceId?: string;
}>;

export const EmbeddedTerminalPane = React.memo(function EmbeddedTerminalPaneWeb(props: EmbeddedTerminalPaneProps) {
    const uiFontScale = useLocalSetting('uiFontScale');
    const fontMetrics = React.useMemo(() => resolveCodeEditorFontMetrics({ uiFontScale }), [uiFontScale]);
    const xtermRef = props.terminalRef as React.MutableRefObject<XtermTerminalHandle | null>;
    // A phone (including a phone-width browser) gets the key rail and the arrow pad (terminal lab P1).
    const deviceType = useDeviceType();
    const showKeys = props.showQuickKeys ?? deviceType === 'phone';
    const find = useTerminalFind(props, showKeys);
    const [cursorRow, setCursorRow] = React.useState<EmbeddedTerminalCursorRow | null>(null);
    const onCursorRowChange = React.useCallback((next: EmbeddedTerminalCursorRow | null) => {
        setCursorRow((current) => current?.top === next?.top && current?.height === next?.height ? current : next);
    }, []);
    const keys = useTerminalKeys({
        onInput: props.controller.onInput,
        focusRenderer: React.useCallback(() => xtermRef.current?.focus?.(), [xtermRef]),
    });

    return (
        <View ref={find.rootRef} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        <EmbeddedTerminalPaneFrame
            chrome={props.chrome}
            machineName={props.machineName}
            title={props.title}
            controller={props.controller}
            onRequestClose={props.onRequestClose}
            onCopySelection={props.controller.copySelection ? () => props.controller.copySelection?.() : null}
            toolbarActionsStart={props.toolbarActionsStart}
            testIdPrefix={props.testIdPrefix}
            platformOS="web"
            footer={showKeys ? find.open ? find.bar : <TerminalKeyRail modifiers={keys.modifiers} onPressKey={keys.pressRailKey} testIdPrefix={props.testIdPrefix} /> : null}
            surface={(
                <TerminalKeysSurface showArrowPad={showKeys && !find.open} cursorRow={cursorRow} onArrow={keys.pressArrow} testIdPrefix={props.testIdPrefix}>
                    <XtermTerminalView
                        testID={props.testIdPrefix ? `${props.testIdPrefix}-xterm` : undefined}
                        ref={xtermRef}
                        onFindEngine={find.onFindEngine}
                        fontSize={fontMetrics.fontSize}
                        lineHeight={fontMetrics.lineHeight / fontMetrics.fontSize}
                        onInput={showKeys ? keys.onInput : props.controller.onInput}
                        onPaste={props.controller.onPaste}
                        onCopySelection={(text) => props.controller.copySelection?.({ source: 'user-selection', text })}
                        onLink={props.controller.onLink}
                        onResize={props.controller.onResize}
                        onReady={props.controller.onReady}
                        onWriteComplete={props.controller.onWriteComplete}
                        onCursorRowChange={showKeys ? onCursorRowChange : undefined}
                    />
                    {!showKeys ? find.bar : null}
                </TerminalKeysSurface>
            )}
        />
        </View>
    );
});

export default EmbeddedTerminalPane;
