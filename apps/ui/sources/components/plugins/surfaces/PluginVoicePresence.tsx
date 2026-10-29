import * as React from 'react';
import type { VoicePresenceProps, VoiceMarkProps, VoiceStatusLineProps, VoiceTransportProps } from '@happier-dev/plugin-ui';
import { useVoiceAttemptControl, type VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { VoiceMark } from '@/components/voice/presence/VoiceMark';
import { VoiceStatusLine } from '@/components/voice/presence/VoiceStatusLine';
import { VoiceTransport } from '@/components/voice/presence/VoiceTransport';

const VoiceContext = React.createContext<VoiceAttemptControlProjection | null>(null);

/** Context only: lifecycle, subscription and presentation decisions stay in the existing hook. */
export function PluginVoicePresence({ target, children }: VoicePresenceProps): React.ReactElement {
    const voice = useVoiceAttemptControl(target);
    return <VoiceContext.Provider value={voice}>{children}</VoiceContext.Provider>;
}

export function usePluginVoiceAttempt() {
    return React.useContext(VoiceContext)?.publicPresentation ?? null;
}

export function PluginVoiceMark(props: VoiceMarkProps): React.ReactElement | null {
    const voice = React.useContext(VoiceContext);
    return voice ? <VoiceMark voice={voice} size={props.size} testID={props.testID} /> : null;
}
export function PluginVoiceStatusLine(props: VoiceStatusLineProps): React.ReactElement | null {
    const voice = React.useContext(VoiceContext);
    return voice ? <VoiceStatusLine voice={voice} size={props.size} testID={props.testID} /> : null;
}
export function PluginVoiceTransport(props: VoiceTransportProps): React.ReactElement | null {
    const voice = React.useContext(VoiceContext);
    // The public `touch` size predates hit areas: the controls draw at the Island size under every pointer and a
    // finger reaches the platform target through the shared hit area.
    return voice ? <VoiceTransport voice={voice} size={props.size === 'touch' ? 'island' : props.size} testID={props.testID} /> : null;
}
