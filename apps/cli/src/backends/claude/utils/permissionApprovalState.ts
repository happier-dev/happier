import { logger } from '@/lib';
import { configuration } from '@/configuration';
import { isToolAllowedForSession } from '@/agent/permissions/permissionToolIdentifier';
import { applyAllowedToolsToAllowlist, applyUpdatedPermissionsToAllowlist } from '@/agent/permissions/applyPermissionAllowlistUpdates';
import { PermissionRequestPushNotifier } from '@/settings/notifications/permissionRequestPushNotifier';
import {
    getSessionNotificationAgentDisplayName,
    getSessionNotificationTitle,
} from '@/agent/runtime/notifications/sessionNotificationContext';

import type { Session } from '../runtime/session/ClaudeSession';
import type { PermissionMode } from '../runtime/claudeEnhancedMode';

import {
    advertiseClaudePermissionCapabilities,
    applyClaudePermissionRequestPushNotifiedAt,
    clearClaudeSessionModeOverrideBestEffort,
    seedClaudePermissionAllowlistFromAgentState,
} from './permissionAgentState';
import { isInteractiveTool, type PendingRequest, type PermissionResponse } from './permissionCore';
import { startClaudePermissionMetadataWatcher } from './permissionMetadataWatcher';
import { resolveClaudeSdkPermissionModeFromEnhancedMode } from './permissionMode';
import { getToolDescriptor } from './getToolDescriptor';

export class ClaudePermissionApprovalState {
    private permissionRequestPushNotifier: PermissionRequestPushNotifier | null = null;
    private allowedToolIdentifiers = new Set<string>();
    private permissionMode: PermissionMode = 'default';
    private exitedPlanModeLocalIds = new Map<string, number>();
    private exitedPlanModeFallbackUntilMs = 0;
    private metadataWatcherAbort: AbortController | null = null;

    constructor(
        private readonly session: Session,
        onPermissionModeUpdated: (mode: PermissionMode) => void,
    ) {
        advertiseClaudePermissionCapabilities(this.session.client);
        this.seedAllowlistFromAgentState();
        this.startMetadataWatcher(onPermissionModeUpdated);
    }

    getPermissionMode(): PermissionMode {
        return this.permissionMode;
    }

    isToolExplicitlyAllowed(toolName: string, input: unknown): boolean {
        return isToolAllowedForSession(this.allowedToolIdentifiers, toolName, input);
    }

    shouldIgnorePlanModeForCall(localId: string | null): boolean {
        const nowMs = Date.now();
        this.pruneExitPlanModeLocalIds(nowMs);

        const normalized = typeof localId === 'string' ? localId.trim() : '';
        if (normalized.length > 0) {
            const approvedAt = this.exitedPlanModeLocalIds.get(normalized);
            if (!approvedAt) return false;
            return nowMs - approvedAt <= configuration.claudeExitPlanModeLatchMs;
        }

        return nowMs <= this.exitedPlanModeFallbackUntilMs;
    }

    getOrCreatePermissionRequestPushNotifier(): PermissionRequestPushNotifier | null {
        if (!this.session.pushSender) return null;
        if (this.permissionRequestPushNotifier) return this.permissionRequestPushNotifier;
        this.permissionRequestPushNotifier = new PermissionRequestPushNotifier({
            pushSender: this.session.pushSender,
            getSettings: () => this.session.accountSettings ?? null,
            getSettingsSecretsReadKeys: () => this.session.accountSettingsSecretsReadKeys,
            getSessionTitle: () => getSessionNotificationTitle(() => this.session.client.getMetadataSnapshot?.() ?? null),
            getAgentDisplayName: () =>
                getSessionNotificationAgentDisplayName(() => this.session.client.getMetadataSnapshot?.() ?? null) ?? 'Claude',
            sessionId: this.session.client.sessionId,
            logPrefix: '[Claude]',
            onNotifiedAt: (permissionId, notifiedAtMs) => {
                applyClaudePermissionRequestPushNotifiedAt(this.session.client, permissionId, notifiedAtMs);
            },
        });
        return this.permissionRequestPushNotifier;
    }

    markPermissionCompleted(permissionId: string): void {
        this.permissionRequestPushNotifier?.markCompleted(permissionId);
    }

    handleModeChange(
        mode: PermissionMode,
        pendingRequests: ReadonlyMap<string, PendingRequest>,
        applyPermissionResponse: (response: PermissionResponse) => void,
    ): void {
        this.permissionMode = mode;
        this.tryAutoApprovePendingRequestsForPermissionMode(mode, pendingRequests, applyPermissionResponse);
    }

    applyPermissionResponseSideEffects(params: Readonly<{
        response: PermissionResponse;
        toolName: string | null;
        sourceLocalId: string | null;
        pendingRequests: ReadonlyMap<string, PendingRequest>;
        applyPermissionResponse: (response: PermissionResponse) => void;
    }>): void {
        const { response, toolName, sourceLocalId, pendingRequests, applyPermissionResponse } = params;
        if (response.approved) {
            if (response.mode) {
                this.handleModeChange(response.mode, pendingRequests, applyPermissionResponse);
            }
            applyUpdatedPermissionsToAllowlist(this.allowedToolIdentifiers, response.updatedPermissions);

            const allowedTools = response.allowedTools ?? response.allowTools;
            applyAllowedToolsToAllowlist(this.allowedToolIdentifiers, allowedTools);
            this.tryAutoApproveExplicitlyAllowedPendingRequests(pendingRequests, applyPermissionResponse);
        }

        if (response.approved && (toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode')) {
            if (sourceLocalId) {
                this.noteExitPlanModeApproved(sourceLocalId);
            }
            clearClaudeSessionModeOverrideBestEffort(this.session.client);
        }
    }

    reset(): void {
        this.allowedToolIdentifiers.clear();
        this.permissionRequestPushNotifier?.dispose();
        this.permissionRequestPushNotifier = null;
        this.permissionMode = 'default';
        this.exitedPlanModeLocalIds.clear();
        this.exitedPlanModeFallbackUntilMs = 0;
    }

    dispose(): void {
        this.metadataWatcherAbort?.abort();
        this.metadataWatcherAbort = null;
        this.permissionRequestPushNotifier?.dispose();
        this.permissionRequestPushNotifier = null;
    }

    private startMetadataWatcher(onPermissionModeUpdated: (mode: PermissionMode) => void): void {
        if (this.metadataWatcherAbort) return;
        this.metadataWatcherAbort = startClaudePermissionMetadataWatcher({
            session: this.session,
            onPermissionModeUpdated: (nextMode) => onPermissionModeUpdated(nextMode as PermissionMode),
        });
    }

    private tryAutoApproveExplicitlyAllowedPendingRequests(
        pendingRequests: ReadonlyMap<string, PendingRequest>,
        applyPermissionResponse: (response: PermissionResponse) => void,
    ): void {
        if (pendingRequests.size === 0) return;

        const idsToApprove: string[] = [];
        for (const [id, pending] of pendingRequests.entries()) {
            if (isInteractiveTool(pending.toolName)) continue;
            if (this.isToolExplicitlyAllowed(pending.toolName, pending.input)) {
                idsToApprove.push(id);
            }
        }

        for (const id of idsToApprove) {
            if (!pendingRequests.has(id)) continue;
            applyPermissionResponse({ id, approved: true });
        }
    }

    private tryAutoApprovePendingRequestsForPermissionMode(
        mode: PermissionMode,
        pendingRequests: ReadonlyMap<string, PendingRequest>,
        applyPermissionResponse: (response: PermissionResponse) => void,
    ): void {
        if (pendingRequests.size === 0) return;

        const effectiveMode = resolveClaudeSdkPermissionModeFromEnhancedMode({ permissionMode: mode });
        const isEditAutoApproveMode = effectiveMode === 'acceptEdits' || effectiveMode === 'auto';
        if (effectiveMode !== 'bypassPermissions' && !isEditAutoApproveMode) return;

        const idsToApprove: string[] = [];
        for (const [id, pending] of pendingRequests.entries()) {
            if (isInteractiveTool(pending.toolName)) continue;
            if (effectiveMode === 'bypassPermissions') {
                idsToApprove.push(id);
                continue;
            }

            const descriptor = getToolDescriptor(pending.toolName);
            if (descriptor.edit) idsToApprove.push(id);
        }

        for (const id of idsToApprove) {
            if (!pendingRequests.has(id)) continue;
            applyPermissionResponse({ id, approved: true, mode });
        }
    }

    private seedAllowlistFromAgentState(): void {
        try {
            seedClaudePermissionAllowlistFromAgentState(this.session.client, this.allowedToolIdentifiers);
        } catch (error) {
            logger.debug('[Claude] Failed to seed allowlist from agentState', error);
        }
    }

    private pruneExitPlanModeLocalIds(nowMs: number): void {
        const ttlMs = configuration.claudeExitPlanModeLatchMs;
        for (const [localId, approvedAt] of this.exitedPlanModeLocalIds.entries()) {
            if (nowMs - approvedAt > ttlMs) {
                this.exitedPlanModeLocalIds.delete(localId);
            }
        }

        const maxEntries = configuration.claudeExitPlanModeLatchMaxEntries;
        if (this.exitedPlanModeLocalIds.size <= maxEntries) return;

        const entries = Array.from(this.exitedPlanModeLocalIds.entries());
        entries.sort((a, b) => a[1] - b[1]);
        const overflow = entries.length - maxEntries;
        for (let i = 0; i < overflow; i++) {
            this.exitedPlanModeLocalIds.delete(entries[i]![0]);
        }
    }

    private noteExitPlanModeApproved(sourceLocalId: string | null): void {
        const nowMs = Date.now();
        const localId = typeof sourceLocalId === 'string' ? sourceLocalId.trim() : '';
        if (localId.length > 0) {
            this.exitedPlanModeLocalIds.set(localId, nowMs);
            this.pruneExitPlanModeLocalIds(nowMs);
            return;
        }

        const ttlMs = configuration.claudeExitPlanModeLatchMs;
        this.exitedPlanModeFallbackUntilMs = Math.max(this.exitedPlanModeFallbackUntilMs, nowMs + ttlMs);
    }
}
