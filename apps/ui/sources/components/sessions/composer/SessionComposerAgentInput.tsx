import * as React from 'react';
import { AgentInput } from '@/components/sessions/agentInput';
import type { ComposerTextStore } from '@/components/sessions/agentInput/composerTextStore';
import {
    useSessionComposerStructuredInputMentions,
    type SessionAgentInputComposerPersistence,
} from '@/hooks/session/useSessionAgentInputComposerPersistence';

/** The live text is subscribed by the composer's text leaf, outside the Session screen's and the chrome's render graph. */
export function SessionComposerAgentInput({
    textStore,
    pendingText,
    structuredInputPersistence,
    ...props
}: Omit<React.ComponentPropsWithoutRef<typeof AgentInput>, 'value'> & Readonly<{
    textStore: ComposerTextStore;
    pendingText: string | null;
    structuredInputPersistence: SessionAgentInputComposerPersistence['structuredInputPersistence'];
}>) {
    const mentions = useSessionComposerStructuredInputMentions(structuredInputPersistence);
    return <AgentInput {...props} value={pendingText ?? textStore} structuredInputMentions={props.structuredInputMentions ?? mentions} />;
}
