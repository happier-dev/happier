import { OpenProjectDraftSelectionV1Schema, type OpenProjectDraftSelectionV1 } from '@happier-dev/protocol/projects/openProjectDraftV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { writeProjectOpenDraft, flushProjectOpenDraftLocally, type SessionDraftRepository } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { randomUUID } from '@/platform/randomUUID';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

export type RetainedProjectOpenRoute = Readonly<{
    pathname: '/projects/open';
    params: Readonly<{ draftId: string; serverId: string }>;
}>;

/** Entrances retain choices in the incumbent repository; routing never executes Open. */
export async function seedAndOpenProjectDraft(params: Readonly<{
    selection: OpenProjectDraftSelectionV1;
    lifetime: ServerAccountScopeLifetime;
    navigate(route: RetainedProjectOpenRoute): void;
    repository?: Pick<SessionDraftRepository, 'writeProjectOpenDraft' | 'flushProjectOpenDraftLocally'>;
    randomUUID?: () => string;
}>): Promise<boolean> {
    const parsed = OpenProjectDraftSelectionV1Schema.parse(params.selection);
    const source = parsed.source;
    const selection: OpenProjectDraftSelectionV1 = {
        ...parsed, serverId: resolveServerProfileScopeIdForIdentifier(parsed.serverId),
        ...(source && (source.kind === 'source' || source.kind === 'workspace') && source.checkout
            ? { source: { ...source, checkout: { ...source.checkout,
                serverId: resolveServerProfileScopeIdForIdentifier(source.checkout.serverId) } } } : {}),
        ...(parsed.editing?.checkout ? { editing: { ...parsed.editing, checkout: { ...parsed.editing.checkout,
            serverId: resolveServerProfileScopeIdForIdentifier(parsed.editing.checkout.serverId) } } } : {}),
    };
    if (!params.lifetime.isCurrent() || !areServerProfileIdentifiersEquivalent(params.lifetime.scope.serverId, selection.serverId)) return false;
    const draftId = (params.randomUUID ?? randomUUID)();
    const repository = params.repository ?? { writeProjectOpenDraft, flushProjectOpenDraftLocally };
    // The incumbent browser record adapter must load retained custody before any writer.
    await repository.flushProjectOpenDraftLocally({ scope: params.lifetime.scope, draftId });
    if (!params.lifetime.isCurrent()) return false;
    repository.writeProjectOpenDraft({ scope: params.lifetime.scope, draftId, patch: { selection }, materializationIntent: 'seeded' });
    await repository.flushProjectOpenDraftLocally({ scope: params.lifetime.scope, draftId });
    if (!params.lifetime.isCurrent()) return false;
    params.navigate({ pathname: '/projects/open', params: { draftId, serverId: selection.serverId } });
    return true;
}
