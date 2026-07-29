import { LOCAL_BROWSER_PROFILE_ID } from '@/sync/domains/browser/profiles/localBrowserProfile';

import type { BrowserProfileStatusModel } from './BrowserProfileStatus';

/**
 * Whether the compact privacy/security control should surface in the browser
 * toolbar.
 *
 * B-RC5: the always-on "Mode / Storage / Permissions" triad was internal
 * profile plumbing presented as primary chrome. The privacy surface is now
 * actionable-only — it stays hidden for the common case (the host-local default
 * profile with no partition, grants, management actions, or actionable
 * permission state) so a clean browser shows no profile chrome at all.
 *
 * It surfaces when any of the following is true:
 * - a non-default profile is active;
 * - a real storage partition exists;
 * - there is at least one active permission grant;
 * - the permission state is actionable (`denied` or `prompt`);
 * - management actions are available.
 */
export function shouldSurfaceBrowserPrivacy(model: BrowserProfileStatusModel): boolean {
    const isDefaultProfile = model.profile?.profileId === LOCAL_BROWSER_PROFILE_ID;
    const hasPartition = Boolean(model.storagePartition);
    const hasGrants = (model.activePermissionGrantCount ?? 0) > 0;
    const hasActionablePermission = model.permissionState === 'denied' || model.permissionState === 'prompt';
    const hasManagement = Boolean(model.management);
    return !isDefaultProfile || hasPartition || hasGrants || hasActionablePermission || hasManagement;
}
