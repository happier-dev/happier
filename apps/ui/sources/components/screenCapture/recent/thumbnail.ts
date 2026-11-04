import * as React from 'react';
import { readRecentCapture, type NativeRecentCaptureEntry } from '@/desktop/capture/nativeCapture';
import { withVideoFrameSource } from '@/components/workspaces/files/file/videoFrameAccess';

export type RecentCaptureThumbnail = Readonly<{ uri: string; durationSeconds?: number; release?: () => void }>;
export type RecentCaptureThumbnailReader = (entry: NativeRecentCaptureEntry, signal?: AbortSignal) => Promise<RecentCaptureThumbnail>;

/** The tile owns the returned still URL; video source URLs belong to the finite decoder operation. */
export const readRecentCaptureThumbnail: RecentCaptureThumbnailReader = async (entry, signal) => {
    const bytes = await readRecentCapture(entry.path);
    signal?.throwIfAborted();
    const uri = URL.createObjectURL(new Blob([bytes as BlobPart], { type: entry.kind === 'video' ? 'video/mp4' : 'image/png' }));
    if (entry.kind === 'still') return { uri, release: () => URL.revokeObjectURL(uri) };
    try {
        const frame = await withVideoFrameSource(uri, player => player.readFrame({ timeSeconds: 0, width: 320 }), signal);
        return { uri: frame.uri, ...(frame.durationSeconds === undefined ? {} : { durationSeconds: frame.durationSeconds }) };
    } finally { URL.revokeObjectURL(uri); }
};

export function useRecentCaptureThumbnail(entry: NativeRecentCaptureEntry, read: RecentCaptureThumbnailReader, visible: boolean) {
    const [thumbnail, setThumbnail] = React.useState<RecentCaptureThumbnail | null>(null);
    React.useEffect(() => {
        let active = true;
        let held: RecentCaptureThumbnail | undefined;
        const lifetime = new AbortController();
        setThumbnail(null);
        if (visible) void read(entry, lifetime.signal).then(next => {
            if (!active) { next.release?.(); return; }
            held = next;
            setThumbnail(next);
        }).catch(() => undefined);
        return () => { active = false; lifetime.abort(); held?.release?.(); };
    }, [entry, read, visible]);
    return thumbnail;
}
