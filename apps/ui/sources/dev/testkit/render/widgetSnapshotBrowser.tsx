import '@/unistyles';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PluginDeclarativeDocumentV1Schema } from '@happier-dev/protocol/plugins/contributions/ui/declarative-document-authoring';
import { WidgetFlowShell } from '@/components/widgets/flow/WidgetFlowShell';
import { WidgetSnapshotConfirmPanel } from '@/components/widgets/definitions/WidgetSnapshotConfirmPanel';
import { createWidgetSnapshotCaptureSlot } from '@/components/widgets/definitions/widgetSnapshotCapture';
import { ModalProvider } from '@/modal/ModalProvider';
import { PopoverBoundaryProvider } from '@/components/ui/popover/PopoverBoundary';
import { WorkspaceBrowserPresentation } from './WorkspaceBrowserPresentation';

const slot = createWidgetSnapshotCaptureSlot();
let commits = 0;
const snapshotDocument = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: {
    kind: 'text', text: 'Private installed Resource revision 5',
} });
slot.register({ read: () => ({ document: snapshotDocument, current: true, readIdentity: 'private-revision-5', readAuthorized: true,
    digests: ['revision-5'], frozenByPath: new Map(), refresh: async () => {} }), subscribe: () => () => {} });

function SnapshotCard() {
    const anchor = React.useRef<View>(null);
    const boundary = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    return <View ref={boundary} style={{ margin: 100, width: 600, height: 700 }}><PopoverBoundaryProvider boundaryRef={boundary}>
        <View ref={anchor}><button data-testid="open-snapshot" onClick={() => setOpen(true)}>Post a snapshot</button></View>
        {open ? <WidgetFlowShell anchorRef={anchor} title="Post a snapshot" onRequestClose={() => setOpen(false)} testID="snapshot-flow">
            <WidgetSnapshotConfirmPanel surface={{ serverId: 'snapshot-home', accountId: 'snapshot-owner', owner: { kind: 'sessionBoard', sessionId: 'snapshot-session' } }}
                title="Private flower" sourceLabel="Private Resource" capture={slot.capture} watch={slot.watch}
                onDone={() => setOpen(false)} onCancel={() => setOpen(false)} testID="snapshot-browser" />
        </WidgetFlowShell> : null}
    </PopoverBoundaryProvider></View>;
}

Object.assign(globalThis, { widgetSnapshotBrowser: { readCommits: () => commits, mount() {
    createRoot(document.getElementById('root')!).render(<WorkspaceBrowserPresentation><SafeAreaProvider initialMetrics={{
        frame: { x: 0, y: 0, width: innerWidth, height: innerHeight }, insets: { top: 0, right: 0, bottom: 0, left: 0 },
    }}><ModalProvider><React.Profiler id="snapshot-flow" onRender={() => { commits++; }}><SnapshotCard /></React.Profiler></ModalProvider></SafeAreaProvider></WorkspaceBrowserPresentation>);
} } });
