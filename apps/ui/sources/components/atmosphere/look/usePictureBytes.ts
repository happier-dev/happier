import * as React from 'react';
import { pictureStore } from '../pictureStore';
import type { BuiltinPicture, PictureInfo } from '../pictureStore.types';
import { useStoredPictureRecord } from '../useStoredPictureRecord';

type Bytes = Blob | string;

const subscribeUserPictures = (listener: () => void) => pictureStore.subscribe(listener, { kind: 'user' });
const userPicturesRevision = () => pictureStore.getRevision('user');

function useUserPictureRevision() {
  return React.useSyncExternalStore(
    subscribeUserPictures,
    userPicturesRevision,
    () => 0,
  );
}

export type BuiltinThumbnail =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'present'; bytes: Bytes }>
  | Readonly<{ status: 'failed' }>;

const THUMBNAIL_LOADING: BuiltinThumbnail = { status: 'loading' };
const THUMBNAIL_FAILED: BuiltinThumbnail = { status: 'failed' };

/** A failure settles on the existing placeholder. Only a new visit or source attempts acquisition again. */
export function useBuiltinThumbnail(picture: BuiltinPicture | null): BuiltinThumbnail {
  const id = picture?.id;
  const full = picture?.src.full;
  const thumb = picture?.src.thumb;
  const [read, setRead] = React.useState<Readonly<{ id: string; thumb: string; result: BuiltinThumbnail }> | null>(null);
  React.useEffect(() => {
    if (id === undefined || full === undefined || thumb === undefined) return;
    let disposed = false;
    void pictureStore.ensureBuiltinThumbnail({ id, src: { full, thumb } }).then(
      bytes => { if (!disposed) setRead({ id, thumb, result: { status: 'present', bytes } }); },
      () => { if (!disposed) setRead({ id, thumb, result: THUMBNAIL_FAILED }); },
    );
    return () => { disposed = true; };
  }, [id, full, thumb]);
  return picture && read !== null && read.id === id && read.thumb === thumb ? read.result : THUMBNAIL_LOADING;
}

/** A stored picture on this device: still being read, here with its full bytes, or not on this device. */
export type StoredPicture =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'present'; bytes: Bytes }>
  | Readonly<{ status: 'missing' }>;

const LOADING: StoredPicture = { status: 'loading' };
const MISSING: StoredPicture = { status: 'missing' };

export function useStoredPicture(localId: string | null): StoredPicture {
  const stored = useStoredPictureRecord(localId);
  return React.useMemo(() => localId === null ? LOADING : stored.status === 'present'
    ? { status: 'present' as const, bytes: stored.record.data }
    : stored.status === 'missing' ? MISSING : LOADING, [localId, stored]);
}

/** A stored picture's full bytes (a user picture on this device), or null when it is not here. */
export function useStoredPictureBytes(localId: string | null): Bytes | null {
  const picture = useStoredPicture(localId);
  return picture.status === 'present' ? picture.bytes : null;
}

/** The user pictures kept on this device, oldest first. */
export function useUserPictures(): readonly PictureInfo[] {
  const revision = useUserPictureRevision();
  const [pictures, setPictures] = React.useState<readonly PictureInfo[]>([]);
  React.useEffect(() => {
    let disposed = false;
    void pictureStore.list('user').then(
      (list) => {
        if (!disposed)
          setPictures(
            list
              .sort((a, b) => a.createdAtMs - b.createdAtMs),
          );
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [revision]);
  return pictures;
}

/** An image URI for stored bytes: an object URL for a browser Blob (revoked with it), a file URI as is. */
export function usePictureUri(bytes: Bytes | null): string | null {
  const uri = React.useMemo(
    () =>
      bytes === null
        ? null
        : typeof bytes === 'string'
          ? bytes
          : URL.createObjectURL(bytes),
    [bytes],
  );
  React.useEffect(
    () => () => {
      if (uri && typeof bytes !== 'string') URL.revokeObjectURL(uri);
    },
    [bytes, uri],
  );
  return uri;
}
