import * as React from 'react';
import type { VoicePresenceProps, VoiceMarkProps, VoiceStatusLineProps, VoiceTransportProps, VoiceCompactTranscriptProps } from '@happier-dev/plugin-ui';
import { useVoiceAttemptControl, type VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { VoiceMark } from '@/components/voice/presence/VoiceMark';
import { VoiceStatusLine } from '@/components/voice/presence/VoiceStatusLine';
import { VoiceTransport } from '@/components/voice/presence/VoiceTransport';
import { VoiceCompactTranscript } from '@/components/voice/presence/VoiceCompactTranscript';
import { useVoiceReadAloud, VoiceReadAloudGlyph, VoiceReadAloudStatus, VoiceReadAloudStop, type VoiceReadAloud } from '@/components/voice/presence/VoiceReadAloud';
import { resolveVoicePresenceReadAloud } from '@/components/voice/presence/resolveVoicePresenceReadAloud';

const VoiceContext = React.createContext<VoiceAttemptControlProjection | null>(null);
const ReadAloudContext = React.createContext<VoiceReadAloud | null>(null);

export function usePluginVoiceAttempt() {
    return React.useContext(VoiceContext)?.publicPresentation ?? null;
}

export function usePluginVoiceReadAloudPhase() {
    return React.useContext(ReadAloudContext)?.phase ?? null;
}

/** Context only: lifecycle, subscription and presentation decisions stay in the existing hook. */
export function PluginVoicePresence({ target, children }: VoicePresenceProps): React.ReactElement {
    const voice = useVoiceAttemptControl(target);
    const readAloud = useVoiceReadAloud();
    return <VoiceContext.Provider value={voice}><ReadAloudContext.Provider value={readAloud}>{children}</ReadAloudContext.Provider></VoiceContext.Provider>;
}

export function PluginVoiceMark(props: VoiceMarkProps): React.ReactElement | null {
    const voice = React.useContext(VoiceContext);
    const readAloud = React.useContext(ReadAloudContext);
    if (voice && readAloud && resolveVoicePresenceReadAloud(voice, readAloud)) {
        return <VoiceReadAloudGlyph size={props.size} testID={props.testID} />;
    }
    return voice ? <VoiceMark voice={voice} size={props.size} testID={props.testID} /> : null;
}
export function PluginVoiceStatusLine(props: VoiceStatusLineProps): React.ReactElement | null {
    const voice = React.useContext(VoiceContext);
    const readAloud = React.useContext(ReadAloudContext);
    const standalone = voice && readAloud ? resolveVoicePresenceReadAloud(voice, readAloud) : null;
    if (standalone) return <VoiceReadAloudStatus phase={standalone.phase} size={props.size} testID={props.testID} />;
    return voice ? <VoiceStatusLine voice={voice} size={props.size} testID={props.testID} /> : null;
}
export function PluginVoiceCompactTranscript(props: VoiceCompactTranscriptProps): React.ReactElement | null {
    const voice = React.useContext(VoiceContext);
    return voice ? <VoiceCompactTranscript voice={voice} testID={props.testID} /> : null;
}
export function PluginVoiceTransport(props: VoiceTransportProps): React.ReactElement | null {
    const voice = React.useContext(VoiceContext);
    const readAloud = React.useContext(ReadAloudContext);
    const size = props.size === 'touch' ? 'island' : props.size;
    const standalone = voice && readAloud ? resolveVoicePresenceReadAloud(voice, readAloud) : null;
    if (standalone) return <VoiceReadAloudStop readAloud={standalone} size={size}
        testID={`${props.testID ?? 'voice-transport'}-read-aloud-stop`} />;
    // The public `touch` size predates hit areas: the controls draw at the Island size under every pointer and a
    // finger reaches the platform target through the shared hit area.
    return voice ? <VoiceTransport voice={voice} readAloud={readAloud ?? undefined} size={size} testID={props.testID} /> : null;
}
