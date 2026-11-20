import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';

import type { AttachmentFilePickerHandle, AttachmentFilePickerProps, PickedAttachment } from './AttachmentFilePicker.types';
import { nativePickFiles } from '@/utils/files/nativePickFiles';
import { nativePickImages } from '@/utils/files/nativePickImages';

export const AttachmentFilePicker = React.forwardRef<AttachmentFilePickerHandle, AttachmentFilePickerProps>(
    function AttachmentFilePicker(props, ref) {
        const onPickedRef = React.useRef(props.onAttachmentsPicked);
        onPickedRef.current = props.onAttachmentsPicked;

        const openFiles = React.useCallback(() => {
            void (async () => {
                const picked = await nativePickFiles({ multiple: props.multiple });
                if (picked.length > 0) onPickedRef.current(picked as PickedAttachment[]);
            })();
        }, [props.multiple]);

        const openImages = React.useCallback(() => {
            void (async () => {
                const picked = await nativePickImages({ multiple: props.multiple });
                if (picked.length > 0) onPickedRef.current(picked as PickedAttachment[]);
            })();
        }, [props.multiple]);

        const takePhoto = React.useCallback(() => {
            void nativePickImages({
                source: 'camera',
                onPermissionDenied: () => Modal.alert(t('status.permissionRequired'), t('common.cameraPermissionForPhoto')),
            }).then(
                picked => { if (picked.length > 0) onPickedRef.current(picked); },
                () => Modal.alert(t('common.error'), t('common.takePhotoFailed')),
            );
        }, []);

        const open = openFiles;

        React.useImperativeHandle(ref, () => ({ open, openFiles, openImages, takePhoto }), [open, openFiles, openImages, takePhoto]);

        return null;
    }
);
