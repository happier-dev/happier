import type { InboxSessionState } from '@/hooks/inbox/buildInboxSessionState';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { resolveSessionWorkspacePresentation } from '@/sync/domains/session/listing/sessionWorkspacePresentation';
import { resolveEffectiveSessionAppearanceColor, type SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';
import { resolveServerWorkspaceDisplay } from '@/sync/domains/session/organization/workspaceDisplay';
import type { SessionOrganizationLabel } from '@happier-dev/protocol';

export type InboxSessionContextPresentation = Readonly<{
    machineLabel: string | null;
    workspaceName: string | null;
    appearanceColor: SessionAppearanceColor | null;
}>;

export function buildInboxSessionContextByKey(params: Readonly<{
    sessionByKey: InboxSessionState['sessionByKey'];
    machines: Readonly<Record<string, MachineDisplayRenderable>>;
    workspaceLabelsByLabelKey: Readonly<Record<string, SessionOrganizationLabel>>;
    sessionColorsByKey?: ReadonlyMap<string, SessionAppearanceColor>;
}>): ReadonlyMap<string, InboxSessionContextPresentation> {
    const result = new Map<string, InboxSessionContextPresentation>();
    for (const [key, entry] of params.sessionByKey) {
        const metadata = entry.session.metadata ?? null;
        const presentation = resolveSessionWorkspacePresentation({
            metadata,
            machines: params.machines,
        });
        const display = resolveServerWorkspaceDisplay(params.workspaceLabelsByLabelKey, entry.serverId, presentation.workspaceKey);
        result.set(key, {
            machineLabel: presentation.machineId ? presentation.machineLabel : null,
            workspaceName: display.label ?? (presentation.displayTitle || null),
            appearanceColor: resolveEffectiveSessionAppearanceColor({
                sessionColor: params.sessionColorsByKey?.get(key),
                workspaceColor: display.color,
            }),
        });
    }
    return result;
}
