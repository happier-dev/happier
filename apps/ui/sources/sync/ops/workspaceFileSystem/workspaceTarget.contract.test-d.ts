import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { WorkspaceFileSystemTarget } from './workspaceTarget';

type FileTarget<T extends WorkspaceFileSystemTarget> = T;

// @ts-expect-error A managed file read routed to the controller disk must require the exact managed address arm.
export type RejectWorkspaceScopeAsFileTarget = FileTarget<WorkspaceScopeBase>;
