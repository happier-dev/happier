import * as React from 'react';
import { View } from 'react-native';
import { useTerminalFind } from './useTerminalFind';

import { resolveTerminalFontMetrics } from './terminalFontMetrics';
import { useLocalSetting } from '@/sync/domains/state/storage';
import type { XtermTerminalHandle } from '@/components/terminal/xterm/XtermTerminalView.web';
import { SessionPaneLazyLoader } from '@/components/sessions/panes/SessionPaneLazyLoader';
import type { EmbeddedTerminalRendererHandle, EmbeddedTerminalCursorRow } from './embeddedTerminalRendererHandle';
import { useDeviceType } from '@/utils/platform/responsive';
import { EmbeddedTerminalPaneFrame, terminalAcceptsKeys } from './EmbeddedTerminalPaneFrame';
import { TerminalKeyRail } from './keys/TerminalKeyRail';
import { TerminalKeysSurface } from './keys/TerminalKeysSurface';
import { useTerminalKeys } from './keys/useTerminalKeys';
import type { EmbeddedTerminalPaneController } from './types';
import { TerminalAskSelectionControls, type TerminalAskSelectionTarget } from './TerminalAskSelectionControls';

const loadXtermTerminalView = () => import('@/components/terminal/xterm/XtermTerminalView.web')
    .then((module) => module.XtermTerminalView);

export type EmbeddedTerminalPaneProps = Readonly<{
    title: string;
    controller: EmbeddedTerminalPaneController;
    terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
    onRequestClose?: (() => void) | null;
    toolbarActionsStart?: React.ReactNode;
    /** See `EmbeddedTerminalPaneFrame` `chrome`. */
    chrome?: 'toolbar' | 'none';
    machineName?: string | null;
    /** See `EmbeddedTerminalPaneFrame` `ownerStatesExit`. */
    ownerStatesExit?: boolean;
    /** `content`: the terminal hugs its output and gives way to its parent's bound; default `fill`. */
    sizing?: 'fill' | 'content';
    testIdPrefix?: string | null;
    nativeSurfaceKey?: string | null;
    showQuickKeys?: boolean;
    focused?: boolean;
    findSurfaceId?: string;
    /** Where Ask about a terminal selection lands; omit where the terminal has no workspace. */
    askSelection?: TerminalAskSelectionTarget | null;
}>;

export const EmbeddedTerminalPane = React.memo(function EmbeddedTerminalPaneWeb(props: EmbeddedTerminalPaneProps) {
    const uiFontScale = useLocalSetting('uiFontScale');
    const fontMetrics = React.useMemo(() => resolveTerminalFontMetrics({ uiFontScale }), [uiFontScale]);
    const xtermRef = props.terminalRef as React.MutableRefObject<XtermTerminalHandle | null>;
    // A phone (including a phone-width browser) gets the key rail and the arrow pad (terminal lab P1).
    const deviceType = useDeviceType();
    const showKeys = props.showQuickKeys ?? deviceType === 'phone';
    const find = useTerminalFind(props, showKeys);
    const keysOffered = showKeys && terminalAcceptsKeys(props.controller);
    const [contentHeight, setContentHeight] = React.useState<number | null>(null);
    const onContentHeightChange = React.useCallback((height: number) => setContentHeight(Math.ceil(height)), []);
    const hugsContent = props.sizing === 'content';
    const [cursorRow, setCursorRow] = React.useState<EmbeddedTerminalCursorRow | null>(null);
    const onCursorRowChange = React.useCallback((next: EmbeddedTerminalCursorRow | null) => {
        setCursorRow((current) => current?.top === next?.top && current?.height === next?.height ? current : next);
    }, []);
    const selectionListeners = React.useRef(new Set<() => void>());
    const onSelectionChange = React.useCallback(() => {
        for (const listener of selectionListeners.current) listener();
    }, []);
    const subscribeSelection = React.useCallback((listener: () => void) => {
        selectionListeners.current.add(listener);
        return () => { selectionListeners.current.delete(listener); };
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
            ownerStatesExit={props.ownerStatesExit}
            contentHeight={hugsContent ? contentHeight ?? fontMetrics.lineHeight : null}
            title={props.title}
            controller={props.controller}
            onRequestClose={props.onRequestClose}
            onCopySelection={props.controller.copySelection ? () => props.controller.copySelection?.() : null}
            toolbarActionsStart={props.toolbarActionsStart}
            testIdPrefix={props.testIdPrefix}
            platformOS="web"
            footer={showKeys ? find.open ? find.bar : keysOffered ? <TerminalKeyRail modifiers={keys.modifiers} onPressKey={keys.pressRailKey} testIdPrefix={props.testIdPrefix} /> : null : null}
            surface={(
                <TerminalKeysSurface showArrowPad={keysOffered && !find.open} cursorRow={cursorRow} onArrow={keys.pressArrow} testIdPrefix={props.testIdPrefix}>
                    <SessionPaneLazyLoader
                        testID={props.testIdPrefix ? `${props.testIdPrefix}-renderer-loading` : 'terminal-renderer-loading'}
                        load={loadXtermTerminalView}
                        props={{
                            retainedResource: props.controller.rendererResource,
                            testID: props.testIdPrefix ? `${props.testIdPrefix}-xterm` : undefined,
                            ref: xtermRef,
                            onFindEngine: find.onFindEngine,
                            fontSize: fontMetrics.fontSize,
                            readOnly: !terminalAcceptsKeys(props.controller),
                            lineHeight: fontMetrics.lineHeight / fontMetrics.fontSize,
                            onInput: showKeys ? keys.onInput : props.controller.onInput,
                            onPaste: props.controller.onPaste,
                            onCopySelection: (text: string) => props.controller.copySelection?.({ source: 'user-selection', text }),
                            onSelectionChange: props.askSelection ? onSelectionChange : undefined,
                            onLink: props.controller.onLink,
                            onResize: props.controller.onResize,
                            onReady: props.controller.onReady,
                            onWriteComplete: props.controller.onWriteComplete,
                            onCursorRowChange: showKeys ? onCursorRowChange : undefined,
                            onContentHeightChange: hugsContent ? onContentHeightChange : undefined,
                        }}
                    />
                    {!showKeys ? find.bar : null}
                    {props.askSelection ? (
                        <TerminalAskSelectionControls
                            target={props.askSelection}
                            terminalRef={xtermRef}
                            subscribeSelection={subscribeSelection}
                            active={props.focused !== false}
                        />
                    ) : null}
                </TerminalKeysSurface>
            )}
        />
        </View>
    );
});

export default EmbeddedTerminalPane;
