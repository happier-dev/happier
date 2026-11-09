import * as React from 'react';

import { SessionMediaInlineImages } from '@/components/sessions/media/SessionMediaInlineImages';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { resolveStoredImageReadScope } from '@/sync/domains/session/media/resolveStoredImageReadScope';

// `undefined` while this client cannot read the Machine's metadata yet (no record, or a record still being
// re-read); `null` only once its read metadata names no home.
const selectHappyHomeDir = (machine: Machine | null): string | null | undefined =>
    machine?.metadata ? machine.metadata.happyHomeDir ?? null : undefined;

/**
 * A Session image, read from whichever store holds it: the Session's working directory, or the
 * Session media store a daemon keeps under its own home directory (W2B writes those with
 * `storage: 'daemon'`, relative to that home, as the CLI's trusted image reader resolves them). The
 * caller names the machine whose daemon stored it (the Session's machine for the managed browser, the
 * shared window's machine for computer use).
 */
export function SessionStoredImageThumbnail(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    /** The machine whose daemon stored a `daemon` image; unused for Session-workspace images. */
    machineId: string | null;
    storage: 'session' | 'daemon';
    media: React.ComponentProps<typeof SessionMediaInlineImages>['media'];
    mediaPreviewEnabled: boolean;
    testID: string;
}>): React.ReactElement | null {
    const daemonStored = props.storage === 'daemon';
    const serverId = usePreferredServerIdForSession({ sessionId: props.sessionId, serverId: props.serverId });
    const machineId = daemonStored ? props.machineId : null;
    // That server's machine record (not the active server's), through the owner that resolves the
    // Home's profile id and stable identity to one inventory: the daemon reports its home in metadata.
    const readHome = useServerScopedMachine(serverId, serverId ? machineId : null, selectHappyHomeDir);
    // While sync re-reads the record, the home it last settled stands, so a shown picture is not swapped
    // back to its placeholder (the same continuity the Machine label keeps).
    const settledHome = React.useRef<Readonly<{ machineId: string | null; home: string | null }> | null>(null);
    if (readHome !== undefined) settledHome.current = { machineId, home: readHome };
    const daemonHome = readHome !== undefined ? readHome
        : settledHome.current?.machineId === machineId ? settledHome.current.home : undefined;
    const workspaceScope = React.useMemo(() => resolveStoredImageReadScope({
        storage: props.storage, sessionScope: null,
        daemon: { serverId, machineId, happyHomeDir: daemonHome ?? null },
    }), [daemonHome, props.storage, machineId, serverId]);
    // A daemon image whose machine record names no home has no readable root: show nothing rather than a
    // tile that can only fail. While the record is still arriving, the tile keeps its place (inert, no read),
    // so the card does not reflow when the picture's root becomes known.
    if (daemonStored && !workspaceScope) {
        if (daemonHome !== undefined) return null;
        return (
            <SessionMediaInlineImages
                sessionId={props.sessionId}
                media={props.media}
                onOpenPath={() => undefined}
                fileOpenEnabled={false}
                mediaPreviewEnabled={false}
                testIdPrefix={props.testID}
            />
        );
    }
    return (
        <SessionMediaInlineImages
            sessionId={props.sessionId}
            workspaceScope={workspaceScope}
            media={props.media}
            onOpenPath={() => undefined}
            fileOpenEnabled={false}
            mediaPreviewEnabled={props.mediaPreviewEnabled}
            testIdPrefix={props.testID}
        />
    );
}
