import * as React from 'react';

import type { AttachmentFilePickerHandle, AttachmentFilePickerProps, PickedAttachment } from './AttachmentFilePicker.types';

export const AttachmentFilePicker = React.forwardRef<AttachmentFilePickerHandle, AttachmentFilePickerProps>(
    function AttachmentFilePicker(props, ref) {
        const inputRef = React.useRef<HTMLInputElement | null>(null);

        const openFiles = React.useCallback(() => {
            if (inputRef.current) {
                inputRef.current.accept = '';
                inputRef.current.click();
            }
        }, []);

        const openImages = React.useCallback(() => {
            if (inputRef.current) {
                inputRef.current.accept = 'image/*';
                inputRef.current.click();
            }
        }, []);

        React.useImperativeHandle(ref, () => ({
            open: openFiles,
            openFiles,
            openImages,
        }), [openFiles, openImages]);

        return (
            <input
                ref={inputRef}
                type="file"
                style={{ display: 'none' }}
                multiple={props.multiple !== false}
                onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length > 0) {
                        const picked: PickedAttachment[] = files.map((file) => ({ kind: 'web', file }));
                        props.onAttachmentsPicked(picked);
                    }
                    // Reset so picking the same file again still triggers onChange.
                    e.target.value = '';
                }}
            />
        );
    }
);
