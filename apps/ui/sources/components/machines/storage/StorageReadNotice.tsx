import * as React from 'react';
import type { StorageReadIssueV1 } from '@happier-dev/protocol/storage/storageV1';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { storageCategoryTitle } from './storageReasonPresentation';

/**
 * A successful partial read keeps its data and explains the owner's incomplete categories. Its one
 * action is the owner's remedy (admin access lives in the Security tab); trying again only follows it.
 */
export function StorageReadNotice(props: Readonly<{
    issues: readonly StorageReadIssueV1[] | undefined;
    onRetry: () => void;
    /** Opens the Security tab's admin access; absent for someone who cannot change it. */
    onOpenRemedy?: () => void;
}>) {
    if (!props.issues?.length) return null;
    const categories = [...new Set(props.issues.map(issue => issue.categoryId))].map(storageCategoryTitle).join(', ');
    return (
        <ItemGroup header="none">
            <SurfaceStateCard testID="machine-storage-incomplete" kind="warning" size="line"
                title={t('machineStorage.states.incomplete', { categories })}
                reason={`${t('machineStorage.states.permissionDeniedReason')} ${t('machineStorage.states.incompletePermissionRemedy')}`}
                {...(props.onOpenRemedy && props.issues.some(issue => issue.remedy === 'grant_admin_access_or_run_as_machine_owner') ? {
                    action: { label: t('machineStorage.states.openAdminAccess'), onPress: props.onOpenRemedy, testID: 'machine-storage-incomplete-remedy' },
                    secondaryAction: { label: t('machineStorage.tryAgain'), onPress: props.onRetry, testID: 'machine-storage-incomplete-retry' },
                } : {
                    action: { label: t('machineStorage.tryAgain'), onPress: props.onRetry, testID: 'machine-storage-incomplete-retry' },
                })} />
        </ItemGroup>
    );
}
