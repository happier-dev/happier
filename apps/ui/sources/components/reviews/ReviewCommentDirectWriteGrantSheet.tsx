import React from 'react';

import { PluginPermissionGrantSheet } from '@/components/plugins/permissions/PluginPermissionGrantSheet';
import type { PluginPermissionPendingGrantRequest } from '@/sync/domains/plugins/permissions/types';

export type ReviewCommentDirectWriteGrantSheetProps = Readonly<{
    pendingRequest: PluginPermissionPendingGrantRequest;
    labels: Readonly<{
        title: string;
        body: (params: Readonly<{ pluginName: string; pluginId: string }>) => string;
        grant: string;
        cancel: string;
    }>;
    onGrant: (input: Readonly<{ requestId: string }>) => void;
    onCancel: (input: Readonly<{ requestId: string }>) => void;
    testID?: string;
}>;

export function ReviewCommentDirectWriteGrantSheet(props: ReviewCommentDirectWriteGrantSheetProps) {
    return (
        <PluginPermissionGrantSheet
            pendingRequest={props.pendingRequest}
            labels={{
                title: props.labels.title,
                body: props.labels.body,
                grant: props.labels.grant,
                dismiss: props.labels.cancel,
            }}
            onGrant={props.onGrant}
            onDismiss={props.onCancel}
            testID={props.testID}
        />
    );
}
