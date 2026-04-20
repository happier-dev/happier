import { storage } from '@/sync/domains/state/storage';
import {
    resolveWorkspaceTargetForSessionFromState,
    type WorkspaceTargetForSession,
} from './resolveWorkspaceTargetForSessionFromState';

export type { WorkspaceTargetForSession };

export function resolveWorkspaceTargetForSession(sessionId: string): WorkspaceTargetForSession | null {
    return resolveWorkspaceTargetForSessionFromState(storage.getState(), sessionId);
}
