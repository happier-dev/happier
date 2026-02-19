import * as React from 'react';

import type { AttachmentFilePickerHandle, AttachmentFilePickerProps, PickedAttachment } from './AttachmentFilePicker.types';

function sanitizePickedName(raw: unknown): string {
    const value = typeof raw === 'string' ? raw : '';
    const trimmed = value.trim();
    if (!trimmed) return 'file';
    const base = trimmed.split(/[/\\]/g).pop() ?? 'file';
    return base.trim() || 'file';
}

export const AttachmentFilePicker = React.forwardRef<AttachmentFilePickerHandle, AttachmentFilePickerProps>(
    function AttachmentFilePicker(props, ref) {
        const onPickedRef = React.useRef(props.onAttachmentsPicked);
        onPickedRef.current = props.onAttachmentsPicked;

        const open = React.useCallback(() => {
            void (async () => {
                const DocumentPicker: any = await import('expo-document-picker');
                const result = await DocumentPicker.getDocumentAsync({
                    multiple: props.multiple !== false,
                    type: '*/*',
                });
                if (!result || result.canceled) return;

                const assets = Array.isArray(result.assets) ? result.assets : [];
                const mapped: Array<Extract<PickedAttachment, { kind: 'native' }>> = assets
                    .map((asset: any) => ({
                        kind: 'native' as const,
                        uri: typeof asset?.uri === 'string' ? asset.uri : '',
                        name: sanitizePickedName(asset?.name),
                        sizeBytes: typeof asset?.size === 'number' ? asset.size : null,
                        mimeType: typeof asset?.mimeType === 'string' ? asset.mimeType : null,
                    }));
                const picked = mapped.filter((a) => a.uri.length > 0);

                if (picked.length > 0) {
                    onPickedRef.current(picked);
                }
            })();
        }, [props.multiple]);

        React.useImperativeHandle(ref, () => ({ open }), [open]);

        return null;
    }
);
