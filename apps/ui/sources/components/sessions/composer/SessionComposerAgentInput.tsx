import * as React from 'react';
import { AgentInput } from '@/components/sessions/agentInput';
import type { ComposerTextStore } from '@/components/sessions/agentInput/composerTextStore';
import {
    useSessionComposerStructuredInputMentions,
    type SessionAgentInputComposerPersistence,
} from '@/hooks/session/useSessionAgentInputComposerPersistence';
import { useSessionComposerColumn } from './SessionComposerColumn';

/** The live text is subscribed by the composer's text leaf, outside the Session screen's and the chrome's render graph. */
export function SessionComposerAgentInput({
    textStore,
    pendingText,
    structuredInputPersistence,
    ...props
}: Omit<React.ComponentPropsWithoutRef<typeof AgentInput>, 'value' | 'maxPanelHeight' | 'inputMaxHeight' | 'inputExpansion'> & Readonly<{
    textStore: ComposerTextStore;
    pendingText: string | null;
    structuredInputPersistence: SessionAgentInputComposerPersistence['structuredInputPersistence'];
}>) {
    const mentions = useSessionComposerStructuredInputMentions(structuredInputPersistence);
    // The column owner (under the keyboard scaffold) decides the caps; the input reports its textless height to it.
    const column = useSessionComposerColumn();
    const caps = column?.caps;
    return <AgentInput {...props}
        maxPanelHeight={caps?.maxPanelHeight}
        inputMaxHeight={caps?.inputMaxHeight}
        inputExpansion={caps?.inputExpansion}
        onTextlessHeightChange={column?.reportTextlessHeight}
        value={pendingText ?? textStore} structuredInputMentions={props.structuredInputMentions ?? mentions} />;
}
