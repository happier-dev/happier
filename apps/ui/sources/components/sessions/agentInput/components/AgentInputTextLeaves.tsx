import * as React from 'react';

import { projectComposerDocumentPreviewReferences } from '@/components/sessions/authoring/authoringDocumentPreview';
import { SessionAuthoringComposer, type SessionAuthoringComposerProps } from '@/components/sessions/authoring/SessionAuthoringComposer';
import type { MultiTextInputHandle } from '@/components/ui/forms/MultiTextInput';
import type { ComposerEditorReference } from '@/components/ui/forms/composerEditor/composerEditorTypes';

import { useComposerTextValue, type ComposerTextSource } from '../composerTextStore';
import type { ComposerStructuredInputMention } from '../structuredInputMentions';
import { AgentInputReadOnlyText } from './AgentInputReadOnlyText';

/**
 * The composer's live text is read only by these leaves, so an ordinary key renders them and not
 * the AgentInput chrome (chip row, overlays, command menu) that owns them.
 */

export type AgentInputTextFieldProps = Omit<SessionAuthoringComposerProps, 'value' | 'references'> & Readonly<{
    textSource: ComposerTextSource;
    buildReferences: (text: string) => readonly ComposerEditorReference<ComposerStructuredInputMention>[];
}>;

// Memoized so a chrome-only change (an attachment badge, a chip, an overlay) does not render the text and selection
// owner; the text itself still arrives through `textSource`.
export const AgentInputTextField = React.memo(React.forwardRef<MultiTextInputHandle, AgentInputTextFieldProps>(
    function AgentInputTextField({ textSource, buildReferences, ...fieldProps }, ref) {
        const value = useComposerTextValue(textSource);
        const references = React.useMemo(() => buildReferences(value), [buildReferences, value]);
        return <SessionAuthoringComposer {...fieldProps} ref={ref} value={value} references={references} />;
    },
));

/** Runs `onText` after a commit that carries new text, with the same timing as an effect on the text. */
export function AgentInputTextSync(props: Readonly<{
    textSource: ComposerTextSource;
    onText: (text: string) => void;
}>): null {
    const text = useComposerTextValue(props.textSource);
    const { onText } = props;
    React.useEffect(() => onText(text), [onText, text]);
    return null;
}

export function AgentInputReadOnlyDocumentText(props: Readonly<{
    source: ComposerTextSource;
    mentions: readonly ComposerStructuredInputMention[];
} & Omit<React.ComponentProps<typeof AgentInputReadOnlyText>, 'value' | 'references'>>): React.ReactElement {
    const { source, mentions, ...textProps } = props;
    const value = useComposerTextValue(source);
    const references = React.useMemo(() => projectComposerDocumentPreviewReferences(value, mentions), [value, mentions]);
    return <AgentInputReadOnlyText {...textProps} value={value} references={references} />;
}
