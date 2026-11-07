import * as React from 'react';

import type { AttachmentFilePickerHandle, AttachmentFilePickerProps, PickedAttachment } from './AttachmentFilePicker.types';
import { nativePickFiles } from '@/utils/files/nativePickFiles';
import { nativePickImages, nativeTakePhoto } from '@/utils/files/nativePickImages';
import { captureExceptionIfEnabled } from '@/utils/system/sentry';
import { Modal } from '@/modal';
import { t } from '@/text';

type NativePickerKind = 'files' | 'images' | 'camera';

function reportNativePickerError(error: unknown, kind: NativePickerKind, multiple: boolean): void {
    captureExceptionIfEnabled(error, {
        tags: {
            area: 'attachments',
            picker: kind,
        },
        extra: {
            multiple,
        },
    });
}

export const AttachmentFilePicker = React.forwardRef<AttachmentFilePickerHandle, AttachmentFilePickerProps>(
    function AttachmentFilePicker(props, ref) {
        const onPickedRef = React.useRef(props.onAttachmentsPicked);
        onPickedRef.current = props.onAttachmentsPicked;

        const openFiles = React.useCallback(() => {
            void (async () => {
                const multiple = props.multiple !== false;
                try {
                    const picked = await nativePickFiles({ multiple: props.multiple });
                    if (picked.length > 0) onPickedRef.current(picked as PickedAttachment[]);
                } catch (error) {
                    reportNativePickerError(error, 'files', multiple);
                }
            })();
        }, [props.multiple]);

        const openImages = React.useCallback(() => {
            void (async () => {
                const multiple = props.multiple !== false;
                try {
                    const picked = await nativePickImages({ multiple: props.multiple });
                    if (picked.length > 0) onPickedRef.current(picked as PickedAttachment[]);
                } catch (error) {
                    reportNativePickerError(error, 'images', multiple);
                }
            })();
        }, [props.multiple]);

        const takePhoto = React.useCallback(() => {
            void (async () => {
                try {
                    const result = await nativeTakePhoto();
                    if (result.status === 'permissionDenied') {
                        Modal.alert(
                            t('attachments.alerts.cameraPermissionDeniedTitle'),
                            t('attachments.alerts.cameraPermissionDeniedBody'),
                        );
                        return;
                    }
                    if (result.status === 'captured') onPickedRef.current(result.files as PickedAttachment[]);
                } catch (error) {
                    reportNativePickerError(error, 'camera', false);
                }
            })();
        }, []);

        const open = openFiles;

        React.useImperativeHandle(
            ref,
            () => ({ open, openFiles, openImages, takePhoto }),
            [open, openFiles, openImages, takePhoto],
        );

        return null;
    }
);
