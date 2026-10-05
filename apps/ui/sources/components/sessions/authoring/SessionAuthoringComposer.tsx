import type { ComposerRefV1 } from '@happier-dev/protocol';
import { composerRefV1Key } from '@happier-dev/protocol/plugins/ui/composerRef';
import * as React from 'react';

import {
    MultiTextInput,
    type MultiTextInputHandle,
    type MultiTextInputProps,
    type TextInputState,
} from '@/components/ui/forms/MultiTextInput';
import { applyDictationToComposer } from '@/components/sessions/agentInput/applyDictationToComposer';
import { useTextInputDictation, type TextInputDictation } from '@/voice/dictation/useTextInputDictation';

export type SessionAuthoringComposerDictation = TextInputDictation;

export function useSessionAuthoringComposerDictation(input: Readonly<{
    composerRef: ComposerRefV1 | null;
    enabled: boolean;
    presented: boolean;
    editable: boolean;
    transcriptionSessionId: string | null;
    inputRef: React.RefObject<MultiTextInputHandle | null>;
    stateRef: React.MutableRefObject<TextInputState>;
}>): SessionAuthoringComposerDictation {
    const composerKey = React.useMemo(
        () => input.composerRef === null ? '' : composerRefV1Key(input.composerRef),
        [input.composerRef],
    );
    return useTextInputDictation({
        controlId: composerKey,
        enabled: input.enabled,
        presented: input.presented,
        editable: input.editable,
        transcriptionSessionId: input.transcriptionSessionId,
        onTranscription(text) {
            input.stateRef.current = applyDictationToComposer({
                input: input.inputRef.current,
                state: input.stateRef.current,
                text,
            });
        },
    });
}

export type SessionAuthoringComposerProps = MultiTextInputProps & Readonly<{
    /** Exact host-owned document identity; it is never an execution Session substitute. */
    composerRef: ComposerRefV1 | null;
    /** Real Session context for Session-aware STT routing; absent for portable drafts. */
    transcriptionSessionId?: string | null;
    dictationEnabled?: boolean;
    presented?: boolean;
    /** Lets the host place the canonical dictation control in its existing field chrome. */
    renderDictationAccessory?: (dictation: SessionAuthoringComposerDictation) => React.ReactNode;
}>;

function SessionAuthoringComposerDictationAccessory(props: Readonly<{
    composerRef: ComposerRefV1 | null;
    presented: boolean;
    editable: boolean;
    transcriptionSessionId: string | null;
    inputRef: React.RefObject<MultiTextInputHandle | null>;
    stateRef: React.MutableRefObject<TextInputState>;
    render: NonNullable<SessionAuthoringComposerProps['renderDictationAccessory']>;
}>): React.ReactElement {
    const dictation = useSessionAuthoringComposerDictation({
        composerRef: props.composerRef,
        enabled: true,
        presented: props.presented,
        editable: props.editable,
        transcriptionSessionId: props.transcriptionSessionId,
        inputRef: props.inputRef,
        stateRef: props.stateRef,
    });
    return <>{props.render(dictation)}</>;
}

/**
 * The origin-neutral authoring text surface shared by live Session and Workflow
 * composers. It owns text selection plus Dictation's exact live-composer
 * correlation only; persistence, submission, references, attachments and
 * runtime authority remain with the controlled host.
 */
const SessionAuthoringComposerSurface = React.forwardRef<
    MultiTextInputHandle,
    SessionAuthoringComposerProps
>((props, forwardedRef) => {
    const {
        composerRef,
        transcriptionSessionId,
        dictationEnabled = false,
        presented = true,
        renderDictationAccessory,
        onStateChange,
        value,
        ...inputProps
    } = props;
    const inputRef = React.useRef<MultiTextInputHandle>(null);
    React.useImperativeHandle(forwardedRef, () => inputRef.current!, []);

    const stateRef = React.useRef<TextInputState>({
        text: value,
        selection: { start: value.length, end: value.length },
    });
    React.useEffect(() => {
        if (stateRef.current.text === value) return;
        const selection = stateRef.current.selection;
        stateRef.current = {
            text: value,
            selection: {
                start: Math.min(selection.start, value.length),
                end: Math.min(selection.end, value.length),
            },
        };
    }, [value]);

    const handleStateChange = React.useCallback((state: TextInputState) => {
        stateRef.current = state;
        onStateChange?.(state);
    }, [onStateChange]);

    return (
        <>
            <MultiTextInput
                {...inputProps}
                ref={inputRef}
                value={value}
                onStateChange={handleStateChange}
            />
            {dictationEnabled && renderDictationAccessory
                ? <SessionAuthoringComposerDictationAccessory
                    composerRef={composerRef}
                    presented={presented}
                    editable={inputProps.editable !== false}
                    transcriptionSessionId={transcriptionSessionId ?? null}
                    inputRef={inputRef}
                    stateRef={stateRef}
                    render={renderDictationAccessory}
                />
                : null}
        </>
    );
});

SessionAuthoringComposerSurface.displayName = 'SessionAuthoringComposerSurface';

export const SessionAuthoringComposer = React.forwardRef<MultiTextInputHandle, SessionAuthoringComposerProps>((props, ref) => {
    return <SessionAuthoringComposerSurface {...props} ref={ref} />;
});
SessionAuthoringComposer.displayName = 'SessionAuthoringComposer';
