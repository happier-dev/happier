import * as React from 'react';

import { SessionMediaInlineImages } from '@/components/sessions/media/SessionMediaInlineImages';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useServerScopedMachine } from '@/sync/store/hooks';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { resolveStoredImageReadScope } from '@/sync/domains/session/media/resolveStoredImageReadScope';

const selectHappyHomeDir = (machine: Machine | null): string | null => machine?.metadata?.happyHomeDir ?? null;

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
    const daemonHome = useServerScopedMachine(serverId, serverId ? machineId : null, selectHappyHomeDir);
    const workspaceScope = React.useMemo(() => resolveStoredImageReadScope({
        storage: props.storage, sessionScope: null,
        daemon: { serverId, machineId, happyHomeDir: daemonHome },
    }), [daemonHome, props.storage, machineId, serverId]);
    // A daemon image whose machine this client cannot name has no readable root: show nothing rather
    // than a tile that can only fail.
    if (daemonStored && !workspaceScope) return null;
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
