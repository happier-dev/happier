import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Freeze } from 'react-freeze';
import { Text, View } from 'react-native';
import { FadeOut } from 'react-native-reanimated';

import { InstrumentFrame } from '@/components/sessions/agentInput/instrumentStrip/InstrumentFrame';
import { INSTRUMENT_DURATIONS } from '@/components/instrument/motion/motionTokens';

function PluginBadge({ ready }: Readonly<{ ready: boolean }>) {
    return ready ? null : <View testID="pending-badge"><Text>Extension loading</Text></View>;
}

/** The phone cockpit freezes Chat while Files is frontmost (sessionCockpitTabs). */
function PhoneEditorChat() {
    const [editing, setEditing] = React.useState(false);
    const [ready, setReady] = React.useState(false);
    return <>
        <button data-testid="edit" onClick={() => setEditing(true)}>Edit</button>
        <button data-testid="chat" onClick={() => setEditing(false)}>Chat</button>
        <button data-testid="resolve-badge" onClick={() => setReady(true)}>Badge ready</button>
        {editing ? <textarea data-testid="files-editor" defaultValue="export const stage = 1;" /> : null}
        <div style={{ display: editing ? 'none' : undefined }}>
            <Freeze freeze={editing}>
                <InstrumentFrame exiting={FadeOut.duration(INSTRUMENT_DURATIONS.entrance)}>
                    <PluginBadge ready={ready} />
                </InstrumentFrame>
                <textarea data-testid="chat-draft" defaultValue="" />
            </Freeze>
        </div>
    </>;
}

Object.assign(globalThis, { phoneEditorChatBrowser: {
    mount() {
        createRoot(document.getElementById('root')!).render(<PhoneEditorChat />);
    },
} });
