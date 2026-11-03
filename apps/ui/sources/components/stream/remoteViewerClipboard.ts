export type RemoteViewerClipboardResult = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: string }>;
export type RemoteViewerClipboardShortcut = (action: 'copy' | 'cut' | 'paste') => Promise<RemoteViewerClipboardResult>;
