import type { PluginApi } from '@happier-dev/plugin-sdk';

type RefreshReviewActionHandler = Parameters<PluginApi['actions']['register']>[1];

/**
 * The packed author lifecycle invokes this safe, empty-input Action after the
 * package is installed. The hosted surface reaches the same declared Action
 * through the mount-bound host API rather than owning a browser-local result.
 */
export const runReviewRefresh: RefreshReviewActionHandler = async () => ({ ready: true });
