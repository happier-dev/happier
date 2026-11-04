import { readSessionSelectionSnapshot } from '@/components/sessions/selection/readSessionChooserPage';
import { projectSessionSelectionRows } from '@/components/sessions/selection/projectSessionSelectionRows';
import type { SessionChooserTarget } from '@/components/sessions/selection/sessionChooserSource';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { readSessionFileUploadAvailability } from '@/components/sessions/files/readSessionFileUploadAvailability';
import { createExistingSessionComposerDocumentOwner } from '@/components/sessions/composer/existingSessionComposerDocumentOwner';
import type { ComposerDraftDocument } from '@/components/sessions/composer/composerDocumentOwner';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { resolveCaptureDefaultSelection } from './resolveCaptureDefaultTarget';

function hasDraftText(document: ComposerDraftDocument): boolean {
    let boundary = 0;
    for (const mention of document.structuredInputMentions) {
        if (document.text.slice(boundary, mention.start).trim()) return true;
        boundary = mention.end;
    }
    return document.text.slice(boundary).trim().length > 0;
}

/** One read per show or target change; no subscription to the moving Session inventory. */
export async function readCaptureSessionChooserTarget(request: Readonly<{ targetSession?: SessionAddress }>): Promise<SessionChooserTarget> {
    const candidates = readSessionSelectionSnapshot();
    const { address, defaultReason } = resolveCaptureDefaultSelection({ candidates, targetSession: request.targetSession });
    const reason = defaultReason ? { defaultReason } : {};
    const candidate = address && candidates.find(session => session.serverId === address.serverId && session.id === address.sessionId);
    if (!address || !candidate) return { address, ...reason, accountId: null, row: null, uploadAvailable: false, machineReachability: 'unknown', hasDraftText: false };
    const row = projectSessionSelectionRows([candidate], { requireImageInput: true })[0] ?? null;
    const [availability, resolution] = await Promise.all([
        readSessionFileUploadAvailability(address),
        resolveServerCredentialAccountScope(address.serverId),
    ]);
    const document = resolution.kind === 'bound' ? createExistingSessionComposerDocumentOwner({
        scope: resolution.scope, ref: { kind: 'session', sessionId: address.sessionId },
    }).read().document : null;
    const accountId = resolution.kind === 'bound' ? resolution.scope.accountId : null;
    return { address, ...reason, accountId, row, ...availability, hasDraftText: document !== null && hasDraftText(document) };
}
