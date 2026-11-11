import * as React from 'react';
import { AgentInput } from '@/components/sessions/agentInput';
import type { ComposerTextStore } from '@/components/sessions/agentInput/composerTextStore';
import {
    useSessionComposerStructuredInputMentions,
    type SessionAgentInputComposerPersistence,
} from '@/hooks/session/useSessionAgentInputComposerPersistence';
import { useSessionComposerInputCaps, type SessionComposerInputExpansionState } from './useSessionComposerInputCaps';

/** The live text is subscribed by the composer's text leaf, outside the Session screen's and the chrome's render graph. */
export function SessionComposerAgentInput({
    textStore,
    pendingText,
    structuredInputPersistence,
    cardsHeight,
    expansion,
    ...props
}: Omit<React.ComponentPropsWithoutRef<typeof AgentInput>, 'value' | 'maxPanelHeight' | 'inputMaxHeight' | 'inputExpansion'> & Readonly<{
    textStore: ComposerTextStore;
    pendingText: string | null;
    structuredInputPersistence: SessionAgentInputComposerPersistence['structuredInputPersistence'];
    /** Measured height of the cards stacked above the input in the composer's column. */
    cardsHeight: number;
    expansion: SessionComposerInputExpansionState;
}>) {
    const mentions = useSessionComposerStructuredInputMentions(structuredInputPersistence);
    // The caps read the keyboard scaffold this composer is rendered inside, so they are derived here, not above it.
    const caps = useSessionComposerInputCaps({ reservedHeight: cardsHeight, expansion });
    return <AgentInput {...props} {...caps} value={pendingText ?? textStore} structuredInputMentions={props.structuredInputMentions ?? mentions} />;
}
