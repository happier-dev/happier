import * as React from 'react';

import type { AttachmentFilePickerHandle, AttachmentFilePickerProps, PickedAttachment } from './AttachmentFilePicker.types';

export const AttachmentFilePicker = React.forwardRef<AttachmentFilePickerHandle, AttachmentFilePickerProps>(
    function AttachmentFilePicker(props, ref) {
        const inputRef = React.useRef<HTMLInputElement | null>(null);

        React.useImperativeHandle(ref, () => ({
            open: () => {
                inputRef.current?.click();
            },
        }), []);

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
