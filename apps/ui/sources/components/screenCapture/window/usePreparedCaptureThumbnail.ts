import * as React from 'react';

/** The still editor's prepared PNG preview, separate from its source image URL. */
export function usePreparedCaptureThumbnail(): Readonly<{
    thumbnailUri: string | null;
    setPreparedPng: (png: Uint8Array) => void;
}> {
    const [thumbnail, setThumbnail] = React.useState<Blob | null>(null);
    const [thumbnailUri, setThumbnailUri] = React.useState<string | null>(null);
    const setPreparedPng = React.useCallback((png: Uint8Array) => {
        setThumbnail(new Blob([png as BlobPart], { type: 'image/png' }));
    }, []);
    React.useEffect(() => {
        if (!thumbnail) return;
        const uri = URL.createObjectURL(thumbnail);
        setThumbnailUri(uri);
        return () => { URL.revokeObjectURL(uri); };
    }, [thumbnail]);
    return { thumbnailUri, setPreparedPng };
}
