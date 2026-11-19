import { randomBytes } from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { buildCommittedLaunchMetadata, generateConnectedServiceMaterializationIdentityV1 } from '@happier-dev/agents/session/state/metadataWriters';
import { sealSessionStoredContent } from '@happier-dev/sync-client';
import { buildSessionCreationCorrespondence, buildSessionHostOnboardingInputV1, commitPreparedSessionBirthV1,
    normalizeSessionCreationOrganizationPlacementV1, sessionCreationCorrespondenceMatchesV1,
    SessionInitialAccessEnvelopeHostError, type SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions';
import type { ActionExecutorDeps, SessionCreationHostContinuationV1 } from '@happier-dev/protocol/actions/executor/types';
import { openSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { buildSessionSpawnInitialInputLocalIdV1 } from '@happier-dev/protocol/sessions/messages/spawnedFirstTurn';
import { SessionPendingEnqueueByMachineResponseV1Schema, SessionPendingTemplateOnboardingRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { serializeSessionInputRequestEqualityIntentV1, SESSION_INPUT_REQUEST_META_KEY,
    SESSION_MESSAGE_PROVENANCE_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { sessionModelSelectionV2TeamBindingIntent } from '@happier-dev/protocol/providers/selection/v2';
import { mergeSessionTeamCredentialBindingIntents, readAuthoredSessionModelSelection } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { projectUsageSessionMessageTimingV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { createSessionCreateOrLoad } from '@/sync/domains/session/hostedSystemSession';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { createEnvelopeTransport } from '@/sync/api/session/sessionDataKeyEnvelopeTransport';
import { prepareCurrentSessionDataKeyEnvelopes } from '@/sync/encryption/prepareCurrentSessionDataKeyEnvelopes';
import { readTransferableSessionDataKey } from '@/sync/encryption/readTransferableSessionDataKey';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';

type SpawnArgs = Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0];

/** Browser adapters for the same committed birth lifecycle consumed by the CLI. */
export async function createUiPreparedSessionBirthV1(
    account: LazyActionAccountContext,
    args: SpawnArgs,
    continuation: SessionCreationHostContinuationV1,
): Promise<SessionSpawnNewResultV1> {
    const input = args.admittedInput;
    if (!input || !continuation.hostOnboarding) {
        return { type: 'error' as const, code: 'permission_denied' as const, retryable: false as const };
    }
    account.assertCurrent();
    const { accountMode, encryption } = await account.resolveAccountEncryption(args.signal);
    account.assertCurrent();
    const modelSelection = readAuthoredSessionModelSelection(input) ?? undefined;
    const modelBinding = modelSelection?.v === 2 && modelSelection.ref.source === 'team_resource'
        ? sessionModelSelectionV2TeamBindingIntent(modelSelection)
        : undefined;
    const teamCredentialBindings = mergeSessionTeamCredentialBindingIntents({
        explicit: input.teamCredentialBindings,
        admitted: modelBinding ? [modelBinding] : undefined,
    });
    const correspondence = buildSessionCreationCorrespondence({ identity: { sessionCreationTag: args.sessionCreationTag }, recipe: {
        execution: { machineId: input.executionTarget.machineId, directory: input.directory },
        organization: normalizeSessionCreationOrganizationPlacementV1(input.organizationPlacement),
        agentTarget: input.agentTarget, modelSelection: modelSelection ?? null, profileId: input.profileId ?? null,
        approvalProfileId: input.approvalProfileId, identity: input.identity, memoryEnabled: input.memoryEnabled,
        promptStack: input.promptStack, secretReferenceOverlay: input.secretReferenceOverlay,
        requestedPermissionMode: input.permissionMode ?? null, agentModeId: input.agentModeId ?? null,
        configuration: input.configuration ?? null, connectedServices: input.connectedServices ?? null,
        capabilitySelection: input.capabilitySelection ?? null, transcriptStorage: input.transcriptStorage ?? null,
        terminal: input.terminal ?? null, allowedTools: input.allowedTools, unlistedTools: input.unlistedTools,
        ...(input.checkoutCreationDraft ? { checkoutCreationDraft: input.checkoutCreationDraft } : {}),
    } });
    const accountSettings = await account.readSettings();
    account.assertCurrent();
    const metadata = buildCommittedLaunchMetadata({ options: {
        machineId: input.executionTarget.machineId, sessionCreationCorrespondence: correspondence,
        identity: input.identity, memoryEnabled: input.memoryEnabled, approvalProfileId: input.approvalProfileId,
        promptStack: input.promptStack, initialTitle: input.title, initialSessionRolesV1: args.initialSessionRolesV1,
        modelSelection, connectedServices: input.connectedServices,
        capabilitySelection: input.capabilitySelection, allowedTools: input.allowedTools,
        unlistedTools: input.unlistedTools, workspaceWrites: args.context?.workspaceWrites,
        authoringOrigin: input.authoringOrigin, teamCredentialBindings,
    }, ...(input.directory.kind === 'path' ? { directory: input.directory.path } : {}),
        agentModeId: input.agentModeId, accountSettings,
        materializationIdentity: generateConnectedServiceMaterializationIdentityV1({ randomBytes }) });
    const result = await commitPreparedSessionBirthV1({
        commit: async () => {
            const created = await createSessionCreateOrLoad({ credentials: account.credentials, accountMode, encryption,
                tag: correspondence.sessionCreationTag, metadata, randomBytes,
                organizationPlacement: correspondence.recipe.organization, initialAccess: input.initialAccess,
                primaryTeamId: input.primaryTeamId, teamCredentialBindings,
                manager: input.manager,
                request: (path, init) => account.request(path, { ...init, signal: args.signal }),
                assertCurrent: account.assertCurrent,
            });
            return { sessionId: created.session.id, disposition: created.disposition,
                metadataRevision: created.session.metadataVersion, value: created.session };
        },
        authenticateRejoin: async birth => {
            const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode, envelope: birth.value.ownerMetadata,
                ...(accountMode === 'e2ee' ? { material: resolveAccountScopedCryptoMaterialFromCredentials(account.credentials) } : {}) });
            if (!opened.ok || !sessionCreationCorrespondenceMatchesV1(
                opened.ownerMetadata.system?.sessionCreationCorrespondenceV1, correspondence,
            )) throw Object.assign(new Error('Session creation correspondence conflicts'), { code: 'creation_conflict' });
        },
        bindMachine: async birth => {
            account.assertCurrent();
            const path = `/v1/access-keys/${encodeURIComponent(birth.sessionId)}/${encodeURIComponent(input.executionTarget.machineId)}`;
            const headers = { Authorization: `Bearer ${account.credentials.token}` };
            const existing = await account.request(path, { method: 'GET', headers, signal: args.signal });
            account.assertCurrent();
            if (!existing.ok) throw new Error(`Session Machine access-key lookup failed (${existing.status})`);
            const found: unknown = await existing.json();
            if (found && typeof found === 'object' && Reflect.get(found, 'accessKey')) return;
            const body = { data: `session-machine-control:${encodeBase64(randomBytes(16), 'base64url')}` };
            const created = await account.request(path, { method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: args.signal });
            account.assertCurrent();
            if (created.status !== 200 && created.status !== 409) {
                throw new Error(`Session Machine access-key binding failed (${created.status})`);
            }
        },
        beforeLaunch: async birth => {
            if (accountMode === 'e2ee' && (input.primaryTeamId
                || input.initialAccess?.grants.some(grant => grant.subject.kind !== 'account'))) {
                const capturedEncryptionScope = encryption?.getCurrentEncryptionGenerationScope({ serverId: account.serverId, sessionId: birth.sessionId });
                const sessionDataKey = await readTransferableSessionDataKey({ session: birth.value, encryption });
                const prepared = await withActionAccountRequestSignal(account, args.signal, async signal => {
                    // A captured Account lifetime always supplies the merged cancellation signal.
                    const guard = { signal: signal!, check: account.assertCurrent,
                        isCurrent: () => !signal?.aborted && account.accountLifetime.isCurrent() };
                    return prepareCurrentSessionDataKeyEnvelopes({ sessionEncryptionMode: accountMode,
                        scope: { session: { serverId: account.serverId, sessionId: birth.sessionId } },
                        transport: createEnvelopeTransport({ authority: account, guard, sessionId: birth.sessionId }),
                        sessionDataKey, encryption: encryption ?? undefined, capturedEncryptionScope,
                        isHostScopeCurrent: guard.isCurrent });
                });
                account.assertCurrent();
                if (prepared.status === 'scope_changed') {
                    throw Object.assign(new Error('Account scope changed'), { code: 'action_account_scope_changed' });
                }
                if (prepared.status === 'session_data_key_unavailable') {
                    throw new SessionInitialAccessEnvelopeHostError('session_data_key_unavailable');
                }
            }
            return continuation.beforeLaunch(birth);
        },
        submitInitialInput: async birth => {
            account.assertCurrent();
            const onboarding = buildSessionHostOnboardingInputV1(continuation.hostOnboarding!);
            const record = StrictJsonValueSchema.parse({ role: 'user', content: { type: 'text', text: onboarding.initialInput.text },
                meta: { ...onboarding.meta, source: 'ui', [SESSION_MESSAGE_PROVENANCE_META_KEY]: onboarding.inputAdmission.provenance,
                    [SESSION_INPUT_REQUEST_META_KEY]: onboarding.inputAdmission.request } });
            const localId = buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag: correspondence.sessionCreationTag });
            const usageTimingV1 = projectUsageSessionMessageTimingV1({ sessionId: birth.sessionId,
                message: { id: localId, localId, content: record } });
            let sessionEncryption = null;
            if (accountMode === 'e2ee') {
                if (!encryption) throw new Error('Account encryption unavailable');
                const dataKey = birth.value.dataEncryptionKey ? await encryption.decryptEncryptionKey(birth.value.dataEncryptionKey) : null;
                if (birth.value.dataEncryptionKey && !dataKey) throw new Error('Session encryption unavailable');
                await encryption.initializeSessions(new Map([[birth.sessionId, dataKey]]), {
                    serverId: account.serverId, accountId: account.accountId, signal: args.signal,
                    shouldContinue: () => account.accountLifetime.isCurrent(),
                });
                sessionEncryption = encryption.getSessionEncryption(birth.sessionId);
            }
            const content = await sealSessionStoredContent(accountMode === 'plain'
                ? { mode: 'plain' } : { mode: 'e2ee', encryption: sessionEncryption }, record);
            if (content.status !== 'ready') throw new Error('Session encryption unavailable');
            const requestedAction = { v: 1 as const, kind: 'send_now' as const };
            const requestEqualityEvidenceV1 = sessionEncryption ? { kind: 'e2eeTag' as const,
                tag: sessionEncryption.deriveInputEqualityTagV1(serializeSessionInputRequestEqualityIntentV1({
                    requestEnvelope: { v: 1, kind: 'sessionInputRequest', localId, content: { t: 'plain', v: record } }, requestedAction,
                })) } : undefined;
            const body = SessionPendingTemplateOnboardingRequestV1Schema.parse({
                request: { v: 1, sessionId: birth.sessionId,
                    targetMachineId: input.executionTarget.machineId, localId, content: content.content, usageTimingV1,
                    requestedAction, ...(requestEqualityEvidenceV1 ? { requestEqualityEvidenceV1 } : {}) } });
            account.assertCurrent();
            try {
                const response = await account.request(`/v2/sessions/${encodeURIComponent(birth.sessionId)}/pending/template-onboarding`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: args.signal,
                });
                if (!response.ok) throw new Error(`Session input admission failed (${response.status})`);
                return SessionPendingEnqueueByMachineResponseV1Schema.parse(await response.json()).result;
            } catch {
                // A lost input response cannot undo the ordinary committed Session birth.
                return { status: 'outcomeUnknown', localId, code: 'session_input_action_execution_failed' };
            }
        },
    });
    return { type: 'success' as const, sessionId: result.birth.sessionId, executionTarget: input.executionTarget,
        organizationPlacement: correspondence.recipe.organization,
        disposition: result.birth.disposition, initialInput: result.initialInput };
}
