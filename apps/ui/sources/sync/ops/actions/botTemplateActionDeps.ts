import { createBotTemplateActionExecuteV1, readBotTemplateAuthorDraftV1, listSharedBotTemplateSummariesV1, type BotTemplateOperationPortV1 } from '@happier-dev/protocol/bots/templates/botTemplateOperations';
import { BotTemplateArtifactHeaderV1Schema, BotTemplateDraftRefV1Schema, type BotTemplateDraftV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import type { BotTemplateOpenInputV1, BotTemplateDraftResultV1, BotTemplateInstanceV1 } from '@happier-dev/protocol/bots/templates/botTemplateActionsV1';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from './actionAccountContext';
import { readSessionSnapshotForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { admitProjectWorkspaceCensusForSubject } from '@/sync/domains/workspaces/projectWorkspaceCensusAdmission';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { writeUiSessionStateField } from '@/sync/state/engine';
import { sync } from '@/sync/sync';
import { randomUUID } from '@/platform/randomUUID';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { PromptLibraryStackActionPortV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { createArtifactAccessApi } from '@/sync/api/artifacts/apiArtifacts';
import { readSessionStateFieldFromMetadata, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

const unavailable = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** Follow offers need only the addressed released header, through the existing Account codec. */
export async function readUiBotTemplateReleaseHeader(input: Readonly<{
    serverId: string; artifactId: string; expectedAccountId: string;
}>, signal?: AbortSignal) {
    const account = await captureLazyActionAccountContext(input.serverId, signal);
    try {
        if (account.accountId !== input.expectedAccountId) return unavailable('action_account_scope_changed');
        const row = await account.readArtifactHeader(input.artifactId, { signal });
        const header = BotTemplateArtifactHeaderV1Schema.safeParse(row?.rawHeader ?? row?.header);
        return header.success && header.data.state === 'released' ? header.data : null;
    } finally { account.dispose(); }
}

/** Store discovery borrows BT2's header owner and the captured Account's finite list transport. */
export async function readUiSharedBotTemplateSummaries(input: Readonly<{
    serverId: string; expectedAccountId: string; query: string; cursor?: string;
}>, signal?: AbortSignal) {
    const account = await captureLazyActionAccountContext(input.serverId, signal);
    try {
        if (account.accountId !== input.expectedAccountId) return unavailable('action_account_scope_changed');
        return await listSharedBotTemplateSummariesV1({ serverId: account.serverId, query: input.query,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }), ...(signal ? { signal } : {}), list: account.listArtifacts });
    } finally { account.dispose(); }
}

/** The editor reads its private kind through the existing Account transport, not the ordinary Artifact viewer. */
export async function readUiBotTemplateAuthorDraft(input: Readonly<{
    serverId: string; artifactId: string; expectedAccountId: string;
}>, signal?: AbortSignal): Promise<Readonly<{ draft: BotTemplateDraftV1; revision: BotTemplateDraftResultV1['revision'] }>> {
    const account = await captureLazyActionAccountContext(input.serverId, signal);
    try {
        if (account.accountId !== input.expectedAccountId) return unavailable('action_account_scope_changed');
        const resource = await account.homeHubArtifactTransport.read(input.artifactId, { signal });
        account.assertCurrent(); signal?.throwIfAborted();
        const draft = readBotTemplateAuthorDraftV1(resource);
        return { draft, revision: resource!.revision };
    } finally { account.dispose(); }
}

/** Owner-only Session snapshot, shared by content Actions that consume private work metadata. */
export async function readUiOwnedSessionForAction(account: LazyActionAccountContext, ref: BotTemplateDraftV1['sourceSessionRef'], context: ActionExecutorContext) {
    account.assertCurrent(); context.signal?.throwIfAborted();
    const { session } = await runWithServerRequestAuthorityForServerAccountScope({
        scope: account.accountLifetime.scope, activeRequest: account.request,
        ...(account.prepareRequest ? { prepareRequest: account.prepareRequest } : {}),
    }, authority => readSessionSnapshotForAuthority({ authority, sessionId: ref.sessionId,
        includeTurns: false, isCurrent: account.accountLifetime.isCurrent }));
    account.assertCurrent(); context.signal?.throwIfAborted();
    if (!session || !admitProjectWorkspaceCensusForSubject({
        subject: { kind: 'session', ownerAccountId: session.ownerAccountId, access: session.access, accessLevel: session.accessLevel },
        rowServerId: ref.serverId, censusServerId: account.serverId, viewerAccountId: account.accountId,
    }).admitted) return unavailable('session_target_unavailable');
    const metadata = readSessionOwnerMetadataView(session);
    if (!metadata) return unavailable('session_target_unavailable');
    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    return { metadata, revision: session.metadataVersion,
        ...(typeof metadata.machineId === 'string' && agentId ? { executionTarget: { machineId: metadata.machineId, agentId } } : {}) };
}

export function createUiBotTemplateAction(account: LazyActionAccountContext, open: (input: BotTemplateOpenInputV1) => void | Promise<void>,
    registryPort?: PromptLibraryStackActionPortV1,
    getContent?: () => Pick<ActionExecutorDeps, 'promptDocGet' | 'skillActionExecute' | 'machineSetupPlan'>,
    delivery?: Readonly<{ onPublicLinkIssued?: (link: import('@happier-dev/protocol/actions/executor/artifactPublicLinkActions').ArtifactPublicLinkIssuedV1) => void | Promise<void> }> &
        Pick<BotTemplateOperationPortV1, 'resolveInstantiationRelease'> & Pick<NonNullable<BotTemplateOperationPortV1['recipient']>, 'prepareRequesterAdmission' | 'prepareUpdateRequesterAdmission'>) {
    const writeInstance = async (ref: Readonly<{ serverId: string; sessionId: string }>, instance: BotTemplateInstanceV1,
        expectedInstance: BotTemplateInstanceV1 | null, context: ActionExecutorContext) => {
        const result = await writeUiSessionStateField({ sessionId: ref.sessionId,
            fieldId: 'intent.templateInstance', value: instance, expectedValue: expectedInstance,
            metadataReason: expectedInstance ? 'template.updates.apply' : 'template.instantiate',
            updateSessionMetadataWithRetry: async (sessionId, updater) => {
                let version: number | undefined;
                await sync.patchSessionMetadataWithRetry(sessionId, (metadata, revision) => {
                    context.signal?.throwIfAborted(); return updater(metadata, revision);
                }, { serverId: ref.serverId, accountLifetime: account.accountLifetime,
                    ...(account.prepareRequest ? { prepareRequest: account.prepareRequest } : {}),
                    onMetadataCommitted: revision => { version = revision; } });
                if (version === undefined) return unavailable('session_metadata_unavailable');
                return { version };
            },
        });
        if (!result.ok) unavailable(result.reason);
    };
    return createBotTemplateActionExecuteV1({
        artifacts: account.homeHubArtifactTransport,
        randomId: randomUUID,
        isSameServerId: areServerProfileIdentifiersEquivalent,
        resolveInstantiationRelease: delivery?.resolveInstantiationRelease,
        resolvePluginRelease: async (source, context, signal, purpose) => {
            if (!registryPort) return unavailable('unsupported_action');
            const { createUiRegistryHostV1 } = await import('@/registries/registryHostDeps');
            const registry = await createUiRegistryHostV1(account, registryPort, { ...context, signal: signal ?? context.signal });
            return purpose === 'update' ? registry.readBotTemplateUpdate(source.registryItem, source.contributionId)
                : registry.readBotTemplate(source.registryItem, source.contributionId);
        },
        recipient: {
            prepareRequesterAdmission: delivery?.prepareRequesterAdmission,
            prepareUpdateRequesterAdmission: delivery?.prepareUpdateRequesterAdmission,
            content: {
                get promptDocGet() { return getContent?.().promptDocGet; },
                get skillActionExecute() { return getContent?.().skillActionExecute; },
                get machineSetupPlan() { return getContent?.().machineSetupPlan; },
            },
            reportAcceptedVersion: (input, context) => createArtifactAccessApi(account.credentials, {
                request: account.request, serverId: account.serverId,
            }).reportAcceptedVersion(input, context.signal),
            readSession: (ref, context) => readUiOwnedSessionForAction(account, ref, context),
            writeInstance: (ref, instance, context) => writeInstance(ref, instance, null, context),
            updateInstance: writeInstance,
        },
        open,
        readSourceDraftRef: async (ref, context) => {
            const { metadata } = await readUiOwnedSessionForAction(account, ref, context);
            return readSessionStateFieldFromMetadata(metadata, 'intent.templateDraftRef') ?? null;
        },
        writeSourceDraftRef: async (source, ref, context) => {
            const result = await writeUiSessionStateField({
                sessionId: source.sessionId, fieldId: 'intent.templateDraftRef', value: ref,
                expectedValue: null,
                metadataReason: 'template.draft',
                updateSessionMetadataWithRetry: async (sessionId, updater) => {
                    let version: number | undefined;
                    await sync.patchSessionMetadataWithRetry(sessionId, (metadata, revision) => {
                        context.signal?.throwIfAborted(); return updater(metadata, revision);
                    }, { serverId: source.serverId, accountLifetime: account.accountLifetime,
                        ...(account.prepareRequest ? { prepareRequest: account.prepareRequest } : {}),
                        onMetadataCommitted: revision => { version = revision; } });
                    if (version === undefined) return unavailable('session_metadata_unavailable');
                    return { version };
                },
            });
            if (!result.ok) unavailable(result.reason);
        },
        // Release already admitted this owner-held Artifact and these exact named operands.
        // The incumbent transport owns Account-mode admission and recipient-key preparation.
        grant: async (input, context) => {
            const result = await account.artifactAccessGrants.set(input, context.signal);
            if (result.preparation?.status === 'pending') unavailable('artifact_encryption_material_unavailable');
        },
        ...(delivery?.onPublicLinkIssued ? { signedInLink: async (input: Parameters<NonNullable<BotTemplateOperationPortV1['signedInLink']>>[0], context: ActionExecutorContext) => {
            if (!context.hostReviewedChild) return unavailable('unsupported_action');
            const result = await context.hostReviewedChild.invoke({ action: 'artifact.public_link.create', role: 'signed_in_link',
                input });
            if (!result.ok) unavailable(result.errorCode ?? 'action_failed');
        } } : {}),
    });
}
