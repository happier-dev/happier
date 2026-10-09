import { WorkspaceRefV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WidgetBindingResolutionInputV1 } from '@happier-dev/protocol/widgets';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { sameWorkspaceProject } from '@/sync/domains/workspaces/workspaceRefs';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

/** Authorized Source metadata fills the portable slot; accepted refs own checkout and layout identity. */
export function readProjectWidgetAreaContextV1(input: Readonly<{
    serverId: string; projectRef?: unknown; activeCheckout?: unknown;
    source?: Readonly<{ serverId: string; source: ProjectSourceV1 }> | null;
}>): Readonly<{ status: 'ready' | 'unavailable'; reasonCode?: 'widget_project_source_unavailable'; sourceId: string | null;
    projectIdentity: Readonly<{ serverId: string; projectKey: string }> | null; providedContext: WidgetBindingResolutionInputV1['context'] }> {
    const qualify = (value: unknown) => {
        const parsed = WorkspaceRefV1Schema.safeParse(value);
        return parsed.success && areServerProfileIdentifiersEquivalent(parsed.data.serverId, input.serverId)
            ? { ...parsed.data, serverId: resolveServerProfileScopeIdForIdentifier(parsed.data.serverId) } : null;
    };
    const projectRef = qualify(input.projectRef === undefined ? input.activeCheckout : input.projectRef);
    const checkout = qualify(input.activeCheckout);
    const activeCheckout = projectRef && checkout && sameWorkspaceProject(projectRef, checkout) ? checkout : null;
    const projectIdentity = projectRef ? projectWorkspaceRefV1(projectRef) : null;
    const sourceId = activeCheckout?.source?.sourceId ?? projectRef?.source?.sourceId ?? null;
    const source = input.source && sourceId === input.source.source.id
        && areServerProfileIdentifiersEquivalent(input.source.serverId, input.serverId)
        ? { serverId: resolveServerProfileScopeIdForIdentifier(input.source.serverId), ...input.source.source } : null;
    return { status: source ? 'ready' : 'unavailable', ...(!source ? { reasonCode: 'widget_project_source_unavailable' as const } : {}),
        sourceId, projectIdentity, providedContext: {
        project: source ? [source] : [],
        checkout: activeCheckout ? [activeCheckout] : [],
    } };
}
