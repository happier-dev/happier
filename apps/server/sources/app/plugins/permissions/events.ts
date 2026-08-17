import type { PluginPermissionGrantAuditEventV1 } from "@happier-dev/protocol";
import { PluginPermissionGrantAuditEventV1Schema } from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";
import { prismaRuntime } from "@/storage/prisma";

function stringifyJson(value: unknown): string {
    return JSON.stringify(value);
}

function scopeProjectId(event: PluginPermissionGrantAuditEventV1): string | null {
    return event.targetScope.kind === "project" ? event.targetScope.projectId : null;
}

function scopeWorkspaceId(event: PluginPermissionGrantAuditEventV1): string | null {
    return event.targetScope.kind === "workspace" ? event.targetScope.workspaceId : null;
}

function authorityMachineId(event: PluginPermissionGrantAuditEventV1): string | null {
    return event.authoritySource.kind === "machine_installation" ? event.authoritySource.machineId : null;
}

function authorityInstallationId(event: PluginPermissionGrantAuditEventV1): string | null {
    return event.authoritySource.kind === "machine_installation" ? event.authoritySource.installationId : null;
}

export async function appendPluginPermissionGrantAuditEvent(
    tx: Tx,
    eventInput: PluginPermissionGrantAuditEventV1,
): Promise<void> {
    const event = PluginPermissionGrantAuditEventV1Schema.parse(eventInput);
    await tx.$executeRaw(prismaRuntime.sql`
        INSERT INTO plugin_permission_grant_events (
            event_id, account_id, plugin_id, capability, scope_kind, scope_project_id, scope_workspace_id, subject_json,
            authority_kind, authority_machine_id, authority_installation_id,
            event_kind, actor_json, request_id, grant_id, previous_state_json, next_state_json, reason, created_at
        ) VALUES (
            ${event.eventId}, ${event.accountId}, ${event.pluginId}, ${event.capability}, ${event.targetScope.kind},
            ${scopeProjectId(event)}, ${scopeWorkspaceId(event)}, ${stringifyJson(event.subject)}, ${event.authoritySource.kind},
            ${authorityMachineId(event)}, ${authorityInstallationId(event)}, ${event.eventKind}, ${stringifyJson(event.actor)},
            ${event.requestId ?? null}, ${event.grantId ?? null}, ${stringifyJson(event.previousState ?? null)},
            ${stringifyJson(event.nextState ?? null)}, ${event.reason ?? null}, ${event.createdAt}
        )
    `);
}
