import * as React from 'react';
import { createRoot } from 'react-dom/client';

import { createWebDomScrollObservation } from '@/components/sessions/transcript/viewport/driver/webDomObservation';
import { legendListRenderer } from '@/components/sessions/transcript/viewport/shell/renderer/legendListRenderer';
import { resolveConversationTranscriptListShellFrame } from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';

type Row = Readonly<{ id: string; image?: boolean }>;
const lifetime = {};
const frame = resolveConversationTranscriptListShellFrame({ platformOS: 'web' });
const Renderer = legendListRenderer.Component<Row>;
const extractKey = (row: Row) => row.id;

function renderRow({ item }: Readonly<{ item: Row }>) {
    return <div data-testid={`message-${item.id}`} style={{ padding: '4px 24px', fontSize: 16, lineHeight: '24px' }}>
        {item.id} {'Three herbs share one central clock. Each bed gets morning sun. Rosemary, thyme and mint keep their own labels. '.repeat(item.id === 'note-16' ? 20 : 1)}
        {item.image ? <img src="/delayed-image.svg" style={{ width: '100%', display: 'block' }} /> : null}
    </div>;
}

function App() {
    const [home, setHome] = React.useState(false);
    const [participants, setParticipants] = React.useState(false);
    const [imageRow, setImageRow] = React.useState('note-2');
    const [rows, setRows] = React.useState<readonly Row[]>(() => Array.from({ length: 24 }, (_, i) => ({ id: `note-${i}` })));
    const observation = React.useMemo(createWebDomScrollObservation, []);
    return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <div>
            <button data-testid="home" onClick={() => setHome(true)}>Home</button>
            <button data-testid="back" onClick={() => setHome(false)}>Back</button>
            <button data-testid="participants" onClick={() => setParticipants(true)}>Participants</button>
            <button data-testid="chat" onClick={() => setParticipants(false)}>Chat</button>
            <button data-testid="notes" onClick={() => setRows(current => [
                ...current, ...Array.from({ length: 6 }, (_, i) => ({ id: `new-note-${i}` })),
            ])}>Arriving notes</button>
            <button data-testid="grow" onClick={() => setRows(current => [
                ...current.map(row => row.id === imageRow ? { ...row, image: true } : row),
                ...Array.from({ length: 6 }, (_, i) => ({ id: `new-note-${i + 6}` })),
            ])}>Notes and image</button>
            <input data-testid="image-row" value={imageRow} onChange={event => setImageRow(event.target.value)} />
        </div>
        {!home ? <div data-testid="thread" style={{ height: 321, display: participants ? 'none' : 'flex' }}>
            <Renderer data={rows} dataKey="discussion:browser-retention" viewportRetention={lifetime}
                frame={frame} keyExtractor={extractKey} renderItem={renderRow} webDomObservation={observation} />
        </div> : null}
        <textarea data-testid="draft" defaultValue="Keep this unsent draft" />
    </div>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Transcript browser fixture root missing');
document.body.style.margin = '0';
createRoot(root).render(<App />);
