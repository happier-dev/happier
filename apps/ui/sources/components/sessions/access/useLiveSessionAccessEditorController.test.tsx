import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import tweetnacl from 'tweetnacl';
import {
    type AccountDisplayProfileV1} from '@happier-dev/protocol/account/accountDisplayProfileV1';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import {
    encodeSessionDataKeyEnvelopeCursorV1} from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';
import {
    signAccountContentKeyBindingV1} from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import {
    tryWriteServerEnabledBitInPlace,
} from '@happier-dev/protocol/features/serverEnabledBit';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { AuthProvider } from '@/auth/context/AuthContext';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { teamMembershipFixture, teamPolicyFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { encodeBase64 } from '@/encryption/base64';
import { encodeHex } from '@/encryption/hex';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { createAccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { encryptDataKeyForRecipientV0 } from '@/sync/encryption/directShareEncryption';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { AES256Encryption } from '@/sync/encryption/encryptor';
import { createDataKeyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { type AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';

import { t } from '@/text';
import { useLiveSessionAccessEditorController } from './useLiveSessionAccessEditorController';
import type { SessionAccessEditorController } from './sessionAccessEditorTypes';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

/** The manager's real content key pair; persisted credentials carry its secret as `machineKey`. */
const MANAGER = vi.hoisted(() => ({ serverId: '', accountId: 'manager', keys: null as null | { publicKey: Uint8Array; secretKey: Uint8Array } }));
const TEAM_DIRECTORY = vi.hoisted(() => ({ items: [] as Array<{
    id: string;
    name: string;
    policy: { sessionCreationPolicy: 'private_default' | 'team_default' | 'team_required'; externalSharingPolicy: 'allowed' | 'team_admins_only' | 'disabled' };
}>, failed: false }));

// Persistent credentials and HTTP are the replaced boundaries. Access projection, the
// grant client, the recipient-key owner and its real sealing stay live below them.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    const base64 = await import('@/encryption/base64');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: async (_url, options) => options?.serverId !== MANAGER.serverId ? null : {
                token: `e30.${Buffer.from(JSON.stringify({ sub: MANAGER.accountId })).toString('base64url')}.signature`,
                ...(MANAGER.keys ? {
                    encryption: {
                        publicKey: base64.encodeBase64(MANAGER.keys.publicKey, 'base64'),
                        machineKey: base64.encodeBase64(MANAGER.keys.secretKey, 'base64'),
                    },
                } : {}),
            },
        },
    });
});
const TEAM_MEMBER_LOOKUPS = vi.hoisted(() => ({
    queries: [] as string[],
    members: [] as Array<{ accountId: string; account: AccountDisplayProfileV1 }>,
    principalBatches: [] as string[][],
    principalSignals: [] as (AbortSignal | undefined)[],
    principalGate: null as Promise<void> | null,
}));

installDisconnectedServerSocketBoundary();
let webLocks: ReturnType<typeof installWebLockManagerMock>;

const SESSION_ID = 'collaboration-session';
const CAPABILITIES = {
    readTranscript: true, submitAgentInput: true, editSessionRecords: true,
    approveRuntimePermissions: true, manageAccess: true, managePermissionDelegation: true,
    managePublicLink: true, archiveSession: true, renameSession: true,
    assignResponsibility: true, stopSession: true, deleteSession: true,
};
const OWNER = { kind: 'account', accountId: 'manager', firstName: null, lastName: null, username: 'manager', avatarUrl: null };
const RECIPIENT_ID = 'alice';
const GRANT_ROW = {
    grant: { subject: { kind: 'account' as const, accountId: RECIPIENT_ID }, accessLevel: 'view', canApprovePermissions: false },
    principal: { kind: 'account', accountId: RECIPIENT_ID, firstName: 'Alice', lastName: null, username: 'alice', avatarUrl: null },
    allowedTransitions: { accessLevels: ['view', 'edit', 'admin'], canChangePermissionDelegation: true, canRemove: true },
};
const TEAM_GRANT_ROW = {
    grant: { subject: { kind: 'team' as const, teamId: 'team-acme' }, accessLevel: 'edit', canApprovePermissions: false, requiredByTeamPolicy: true },
    principal: { kind: 'team', teamId: 'team-acme', name: 'Acme' },
    allowedTransitions: { accessLevels: ['edit', 'admin'], canChangePermissionDelegation: false, canRemove: false, reason: 'session_access_team_policy_required' },
};

type EnvelopePage = Readonly<{
    summary: Readonly<{ prepared: number; pending: number; invalid: number; recipientKeyUnavailable: number }>;
    items: readonly unknown[];
    nextCursor?: string | null;
}>;

function createRecipientEnvelopeItem() {
    const content = tweetnacl.box.keyPair();
    const signing = tweetnacl.sign.keyPair();
    return {
        recipientAccountId: RECIPIENT_ID,
        envelopeState: 'missing',
        contentKey: {
            status: 'available',
            accountSigningPublicKey: encodeHex(signing.publicKey),
            contentPublicKey: encodeBase64(content.publicKey, 'base64'),
            contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey,
                contentPublicKey: content.publicKey,
            }), 'base64'),
        },
    };
}

/** Ordinary present-user writes exercise the real direct policy without a fixture waiver. */
function initializeActionSettings(scope: Readonly<{ serverId: string; accountId: string }>) {
    const settingsScope = createAccountSettingsScope(scope.serverId, scope.accountId);
    if (!settingsScope) throw new Error('The settings scope owner rejected this Home/Account pair');
    storage.getState().applySettingsForScope(
        settingsScope,
        {
            ...settingsParse({}),
            actionsSettingsV1: {
                v: 1,
                actions: {},
            },
        },
        1,
    );
}

async function setupHome(options: Readonly<{ sharing: boolean; encrypted: boolean; sessionEncrypted?: boolean }>) {
    const sessionEncrypted = options.sessionEncrypted ?? options.encrypted;
    TEAM_DIRECTORY.items = [];
    const profile = await upsertServerProfile({ name: 'Access Home', serverUrl: 'https://collaboration.example.test' });
    MANAGER.serverId = profile.id;
    MANAGER.keys = options.encrypted ? tweetnacl.box.keyPair() : null;

    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'teams', true)) throw new Error('Expected the canonical Teams feature bit');
    if (!tryWriteServerEnabledBitInPlace(features, 'sharing.session', options.sharing)) {
        throw new Error('The Session sharing feature bit could not be written by its own writer');
    }
    primeServerFeaturesSnapshot({ serverId: profile.id, snapshot: { status: 'ready', features } });
    initializeActionSettings({ serverId: profile.id, accountId: MANAGER.accountId });

    // Only Session-scoped requests are recorded. Direct Account sealing precedes
    // the atomic grant request; the broader audience pass follows acknowledgement.
    const paths: string[] = [];
    const teamPaths: string[] = [];
    const candidatePaths: string[] = [];
    /** The exact collection view each envelope GET asked for, in order. */
    const envelopeStates: string[] = [];
    const recipientEnvelopeItem = createRecipientEnvelopeItem();
    const state = {
        granted: false,
        grantAccessLevel: 'view' as 'view' | 'edit' | 'admin',
        grantMode: 'normal' as 'normal' | 'malformed_after_commit' | 'malformed_without_commit',
        grantFailure: null as null | Readonly<{ status: number; code: string }>,
        mutationChanged: true,
        mutationGate: null as Promise<void> | null,
        primaryTeamId: null as string | null,
        includeRequiredTeamGrant: false,
        additionalTeamIds: [] as string[],
        includeContextGroupGrant: false,
        contextMode: 'normal' as 'normal' | 'denied' | 'malformed_after_commit' | 'malformed_without_commit',
        contextArchived: false,
        candidatePolicyUnavailable: false,
        candidatePolicyGate: null as Promise<void> | null,
        envelopePages: sessionEncrypted ? [{ summary: { prepared: 0, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] }] as EnvelopePage[] : [],
        envelopeStatus: 200,
        uploaded: null as null | { recipientAccountId: string; encryptedDataKey: string },
        directEnvelope: null as null | string,
        sessionSnapshotGates: new Map<string, Promise<void>>(),
        /** A Session row exactly as a Home stores one a 0.2 client created (layout 0). */
        predecessorSession: null as null | Record<string, unknown>,
        metadataPatches: [] as Array<Record<string, unknown>>,
    };
    /**
     * This Home's Artifact rows, answered statefully with the Home's versioned
     * compare-and-set. The client's real codec seals and opens them, so an E2EE
     * Account's approval is stored encrypted exactly as it is in production.
     */
    const artifacts = createArtifactStoreBoundary({
        ownerAccountId: () => MANAGER.accountId,
        encryptionMode: options.encrypted ? 'e2ee' : 'plain',
    });
    const sessionDataKey = new Uint8Array(32).fill(11);
    // The Home stores the fingerprint of the content key this Account published:
    // the one its persisted credentials derive, exactly as the client derives it.
    const managerCredentials = MANAGER.keys ? {
        token: 'manager-token',
        encryption: {
            publicKey: encodeBase64(MANAGER.keys.publicKey, 'base64'),
            machineKey: encodeBase64(MANAGER.keys.secretKey, 'base64'),
        },
    } as AuthCredentials : null;
    const currentSession = createPlainSessionCurrentProjectionRecordFixture({ id: SESSION_ID, metadata: null, metadataVersion: 4, agentStateVersion: 5 });
    if (currentSession.ownerMetadata?.t !== 'plain') throw new Error('Expected the canonical plain owner fixture');
    const currentOwnerMetadata = managerCredentials ? sealSessionOwnerMetadataEnvelopeV1({
        material: resolveAccountScopedCryptoMaterialFromCredentials(managerCredentials),
        ownerMetadata: currentSession.ownerMetadata.v, randomBytes: tweetnacl.randomBytes,
    }) : currentSession.ownerMetadata;
    const [currentSharedMetadata] = sessionEncrypted ? await new AES256Encryption(sessionDataKey).encrypt([{ v: 1 }]) : [];

    setRuntimeFetch(createSessionReadBatchFetchBoundary(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v2/cursor') return Response.json({ cursor: '0' });
        if (path === '/v1/auth/ping') return new Response('{}');
        if (path === '/v1/session-access/principals/resolve') {
            const body = JSON.parse(String(init?.body)) as { subjects: Array<{ kind: string; accountId?: string }> };
            const accountIds = body.subjects.flatMap(subject => subject.kind === 'account' ? [subject.accountId!] : []);
            TEAM_MEMBER_LOOKUPS.principalBatches.push(accountIds);
            TEAM_MEMBER_LOOKUPS.principalSignals.push(init?.signal ?? undefined);
            await TEAM_MEMBER_LOOKUPS.principalGate;
            return Response.json({ v: 1, principals: TEAM_MEMBER_LOOKUPS.members
                .filter(member => accountIds.includes(member.accountId))
                .map(member => ({ kind: 'account', accountId: member.accountId, ...member.account })) });
        }
        if (path === '/v1/teams/list' || path === '/v1/teams/members/list') {
            teamPaths.push(path);
            if (TEAM_DIRECTORY.failed) throw new Error('Team directory network unavailable');
            if (path === '/v1/teams/members/list') {
                const input = JSON.parse(String(init?.body)) as { query?: string; teamId: string };
                TEAM_MEMBER_LOOKUPS.queries.push(input.query ?? '');
                return Response.json({
                    items: TEAM_MEMBER_LOOKUPS.members.filter((member) => member.accountId === input.query).map((member) => teamMembershipFixture({
                        teamId: input.teamId,
                        accountId: member.accountId,
                        account: member.account,
                    })),
                    nextCursor: null,
                });
            }
            return Response.json({
                items: TEAM_DIRECTORY.items.map((team) => teamSummaryFixture({
                    id: team.id, name: team.name, policy: teamPolicyFixture(team.policy),
                })),
                nextCursor: null,
            });
        }
        if (path === '/v2/sessions/access-candidates/inspect') {
            candidatePaths.push(path);
            await state.candidatePolicyGate;
            if (state.candidatePolicyUnavailable) return Response.json({ error: 'not_found' }, { status: 404 });
            const body = JSON.parse(String(init?.body)) as { subjects: Array<{ kind: string; teamId?: string }> };
            const team = TEAM_DIRECTORY.items.find((item) => item.id === state.primaryTeamId);
            const reason = state.contextArchived || team?.policy.externalSharingPolicy === 'disabled'
                ? 'session_access_external_sharing_disabled' : null;
            return Response.json({ v: 1, context: state.primaryTeamId ? {
                teamId: state.primaryTeamId, name: team?.name ?? 'Acme', archived: state.contextArchived,
                externalSharingReason: reason,
            } : null, candidates: body.subjects.map((subject) => ({ subject,
                reason: subject.kind === 'team' && subject.teamId === state.primaryTeamId && !state.contextArchived ? null : reason,
            })) });
        }
        if (path.startsWith('/v2/sessions/')) paths.push(`${init?.method === 'PATCH' ? 'PATCH ' : ''}${path}`);
        // The shared Action front door reads the Account's own settings before it
        // dispatches; this Home has never stored any.
        if (path === '/v2/account/settings') return new Response(JSON.stringify({ content: null, version: 0 }));
        // A plain-Account approval Artifact write first asks the canonical
        // stored-content compatibility owner, then stores the Artifact.
        if (path === '/v1/features' || path.startsWith('/v1/features/')) {
            // The same Home features the snapshot was primed with, plus the
            // stored-content compatibility declaration a current Home publishes.
            const published = features as unknown as Readonly<{ capabilities?: Readonly<Record<string, unknown>> }>;
            return new Response(JSON.stringify({ ...features, capabilities: {
                ...(published.capabilities ?? {}),
                accountStoredContentCompatibility: {
                    v: 1,
                    minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
                    declarationTransport: 'http-header-and-socket-auth-v1',
                },
            } }));
        }
        const artifactResponse = artifacts.handle(path, init);
        if (artifactResponse) return await artifactResponse;
        // The Home answers the mode and the currentness reads with their own exact
        // response schemas; both are strict, so the boundary must not blur them.
        if (path === '/v1/account/encryption') {
            return new Response(JSON.stringify({ mode: options.encrypted ? 'e2ee' : 'plain', updatedAt: 1 }));
        }
        if (path === '/v1/account/encryption/currentness') {
            return Response.json(MANAGER.keys
                ? createDataKeyAccountEncryptionCurrentnessFixture({ machineKey: MANAGER.keys.secretKey, publicKey: MANAGER.keys.publicKey })
                : createPlainAccountEncryptionCurrentnessFixture());
        }
        if (path === `/v1/user/${RECIPIENT_ID}`) {
            const key = recipientEnvelopeItem.contentKey;
            if (key.status !== 'available') throw new Error('Expected available recipient key');
            return new Response(JSON.stringify({ user: {
                id: RECIPIENT_ID, firstName: 'Alice', lastName: null, username: 'alice', avatar: null,
                bio: null, badges: [], status: 'friend', publicKey: key.accountSigningPublicKey,
                recipientEnvelopeReadiness: { status: 'available' },
                contentPublicKey: key.contentPublicKey, contentPublicKeySig: key.contentPublicKeySignature,
            } }));
        }
        if (path === '/v2/sessions/access-grants/list') {
            return new Response(JSON.stringify({
                visibility: 'complete', owner: OWNER, primaryTeamId: state.primaryTeamId,
                grants: [...(state.granted ? [{...GRANT_ROW,grant:{...GRANT_ROW.grant,accessLevel:state.grantAccessLevel}}] : []), ...(state.includeRequiredTeamGrant ? [TEAM_GRANT_ROW] : []), ...state.additionalTeamIds.map(teamId => ({
                    ...TEAM_GRANT_ROW, grant: { ...TEAM_GRANT_ROW.grant, subject: { kind: 'team', teamId } },
                    principal: { kind: 'team', teamId, name: teamId },
                })), ...(state.includeContextGroupGrant ? [{
                    grant: { subject: { kind: 'group', teamId: 'team-acme', groupId: 'reviewers' }, accessLevel: 'view', canApprovePermissions: false },
                    principal: { kind: 'group', teamId: 'team-acme', groupId: 'reviewers', name: 'Reviewers', teamName: 'Product Reliability' },
                    allowedTransitions: { accessLevels: ['view'], canChangePermissionDelegation: false, canRemove: true },
                }] : [])],
                effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: CAPABILITIES },
            }));
        }
        if (path === '/v2/sessions/access-context/set') {
            const body = JSON.parse(String(init?.body)) as { primaryTeamId: string | null };
            if (state.contextMode === 'denied') {
                return new Response(JSON.stringify({ error: 'session_access_external_sharing_disabled' }), { status: 403 });
            }
            if (state.contextMode !== 'malformed_without_commit') state.primaryTeamId = body.primaryTeamId;
            if (state.contextMode === 'malformed_after_commit') return new Response('{}');
            if (state.contextMode === 'malformed_without_commit') return new Response('{}');
            await state.mutationGate;
            return new Response(JSON.stringify({ changed: state.mutationChanged, primaryTeamId: state.primaryTeamId }));
        }
        if (path === '/v2/sessions/access-grants/set') {
            if (state.grantFailure) return Response.json({ error: state.grantFailure.code, statusCode: state.grantFailure.status }, { status: state.grantFailure.status });
            const body = JSON.parse(String(init?.body)) as {
                accessLevel: 'view' | 'edit' | 'admin';
                accountEnvelopeInput?: { encryptedDataKey: string };
            };
            state.directEnvelope = body.accountEnvelopeInput?.encryptedDataKey ?? null;
            if (state.grantMode !== 'malformed_without_commit') {
                state.granted = true;
                state.grantAccessLevel = body.accessLevel;
            }
            if (state.grantMode !== 'normal') return new Response('{}');
            return new Response(JSON.stringify({ changed: state.mutationChanged, grant: {...GRANT_ROW.grant,accessLevel:state.grantAccessLevel} }));
        }
        if (path === '/v2/sessions/access-grants/remove') {
            state.granted = false;
            await state.mutationGate;
            return new Response(JSON.stringify({ changed: state.mutationChanged, subject: GRANT_ROW.grant.subject }));
        }
        const sessionSnapshotMatch = path.match(/^\/v2\/sessions\/([^/]+)$/);
        if (sessionSnapshotMatch && init?.method === 'PATCH') {
            // The Home's tuple CAS for this Session: it stores the owner's split and
            // answers with the committed layout-1 versions.
            const patch = JSON.parse(String(init.body)) as { mode: string; source?: { metadata: { version: number }; agentState: { version: number } } };
            state.metadataPatches.push(patch);
            if (patch.mode !== 'owner_migration' || !patch.source) return new Response(JSON.stringify({ error: 'unexpected' }), { status: 400 });
            state.predecessorSession = null;
            return new Response(JSON.stringify({
                success: true, metadataLayoutVersion: 1,
                sharedMetadata: { version: patch.source.metadata.version + 1 },
                agentState: { version: patch.source.agentState.version + 1 },
            }));
        }
        if (sessionSnapshotMatch && state.predecessorSession && decodeURIComponent(sessionSnapshotMatch[1]!) === SESSION_ID) {
            return new Response(JSON.stringify({ session: state.predecessorSession }));
        }
        if (sessionSnapshotMatch) {
            const sessionId = decodeURIComponent(sessionSnapshotMatch[1]!);
            await state.sessionSnapshotGates.get(sessionId);
            return new Response(JSON.stringify({ session: {
                ...currentSession,
                id: sessionId, createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
                encryptionMode: sessionEncrypted ? 'e2ee' : 'plain',
                dataEncryptionKey: sessionEncrypted && MANAGER.keys
                    ? encryptDataKeyForRecipientV0(sessionDataKey, encodeBase64(MANAGER.keys.publicKey, 'base64'))
                    : null,
                // `metadata` is a required string on the canonical record. A null here
                // is not a "metadata-free" Session: it fails the by-ID parse and sends
                // the read down the compat list fallback, so the key pass would never
                // see this Session's own envelope.
                metadataLayoutVersion: 1, metadataVersion: 4,
                metadata: currentSharedMetadata ? encodeBase64(currentSharedMetadata, 'base64') : currentSession.metadata,
                ownerMetadata: currentOwnerMetadata,
                agentStateVersion: 5, agentState: null, share: null,
                // A collaboration-enabled Home is asked for `accessProjectionVersion=1`,
                // and that projection is parsed strictly: without the effective-access
                // and responsibility pair the by-ID read returns `invalid_response`, so
                // every sealing path that must open this Session's key fails first.
                effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: CAPABILITIES },
                responsibleAccountId: null, responsibleAccount: null,
            } }));
        }
        if (path.endsWith('/turns')) return Response.json({ error: 'not_found' }, { status: 404 });
        if (path.endsWith('/data-key/envelopes')) {
            if (state.envelopeStatus !== 200) return new Response(JSON.stringify({ error: 'session_data_key_envelope_request_failed' }), { status: state.envelopeStatus });
            if (!sessionEncrypted) return new Response(JSON.stringify({ status: 'not_required' }));
            if (init?.method === 'PATCH') {
                const body = JSON.parse(String(init.body)) as { entries: NonNullable<typeof state.uploaded>[] };
                state.uploaded = body.entries[0] ?? null;
                return new Response(JSON.stringify({ appliedCount: body.entries.length }));
            }
            envelopeStates.push(new URL(String(url)).searchParams.get('state') ?? 'action_required');
            const page = state.envelopePages.shift();
            if (!page) throw new Error('Unexpected extra envelope page request');
            return new Response(JSON.stringify({
                status: 'required', summary: page.summary, items: page.items,
                nextCursor: page.nextCursor ?? null,
            }));
        }
        // This Home fixture exposes only the domain surfaces exercised here.
        return Response.json({ error: 'not_found' }, { status: 404 });
    }));

    await setActiveServerId(profile.id, { scope: 'device' });
    const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl, { serverId: profile.id });
    if (!credentials) throw new Error('Expected the manager Account credentials');
    await restoreConnectionToActiveServer(credentials);
    // Cold restore loads this Account's persisted baseline; the test's deliberate
    // settings belong to that actual scope after restoration.
    initializeActionSettings({ serverId: profile.id, accountId: MANAGER.accountId });
    return { profile, paths, teamPaths, candidatePaths, envelopeStates, state, sessionDataKey, artifacts };
}

type ProbeProps = Readonly<{ serverId: string; sessionId?: string; metadataLayoutVersion?: number; detailsDemanded?: boolean; onRender: (controller: SessionAccessEditorController) => void }>;

function Probe(props: ProbeProps) {
    const credentials: AuthCredentials = {
        token: `e30.${Buffer.from(JSON.stringify({ sub: MANAGER.accountId })).toString('base64url')}.signature`,
        ...(MANAGER.keys ? { encryption: {
            publicKey: encodeBase64(MANAGER.keys.publicKey, 'base64'),
            machineKey: encodeBase64(MANAGER.keys.secretKey, 'base64'),
        } } : {}),
    };
    return <AuthProvider initialCredentials={credentials}><ControllerProbe {...props} /></AuthProvider>;
}

function ControllerProbe(props: ProbeProps) {
    props.onRender(useLiveSessionAccessEditorController({
        scope: { serverId: props.serverId, accountId: MANAGER.accountId },
        sessionId: props.sessionId ?? SESSION_ID,
        detailsDemanded: props.detailsDemanded,
        ...(props.metadataLayoutVersion !== undefined ? { metadataLayoutVersion: props.metadataLayoutVersion } : {}),
    }));
    return null;
}

async function mountController(serverId: string, options?: Readonly<{ metadataLayoutVersion?: number }>) {
    let latest: SessionAccessEditorController | null = null;
    await renderScreen(<Probe serverId={serverId} metadataLayoutVersion={options?.metadataLayoutVersion}
        onRender={(controller) => { latest = controller; }} />);
    await vi.waitFor(() => expect(latest!.model.content).toEqual(expect.objectContaining({
        hasLastAcknowledgedSnapshot: true,
    })), { timeout: 5000 });
    return () => latest!;
}

beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    await loadSyncSingletonForTests();
    TEAM_DIRECTORY.failed = false;
    TEAM_MEMBER_LOOKUPS.queries = [];
    TEAM_MEMBER_LOOKUPS.members = [];
    TEAM_MEMBER_LOOKUPS.principalBatches = [];
    TEAM_MEMBER_LOOKUPS.principalSignals = [];
    TEAM_MEMBER_LOOKUPS.principalGate = null;
});

afterEach(async () => {
    standardCleanup();
    await disconnectActiveServerConnection();
    storage.setState(storage.getInitialState(), true);
    MANAGER.serverId = '';
    MANAGER.keys = null;
    webLocks.restore();
});

describe('useLiveSessionAccessEditorController encrypted-access preparation', () => {
    it.each(['database_transaction_conflict_exhausted', 'database_connection_unavailable'])(
        'keeps a refused Team Add unchanged and explains the retryable Home failure: %s', async code => {
            const home = await setupHome({ sharing: true, encrypted: false });
            TEAM_DIRECTORY.items = [{ id: 'team-design', name: 'Design', policy: {
                sessionCreationPolicy: 'team_default', externalSharingPolicy: 'allowed',
            } }];
            home.state.grantFailure = { status: 503, code };
            const controller = await mountController(home.profile.id);
            const teamSection = () => controller().model.directory.sections.find(section => section.kind === 'team')!;
            await vi.waitFor(() => expect(teamSection().candidates).toHaveLength(1));

            await act(async () => { controller().actions.addPrincipal({ kind: 'team', teamId: 'team-design' }); });
            await vi.waitFor(() => expect(teamSection().candidates[0]?.operation.kind).toBe('error'));
            expect(teamSection().candidates[0]?.operation).toMatchObject({ kind: 'error', error: {
                code, message: t(code === 'database_connection_unavailable' ? 'session.access.outcomeUnknown' : 'approvals.transientFailure'), retryable: true,
            } });
            expect(controller().model.grants).toHaveLength(0);
            expect(home.state.granted).toBe(false);
            // The failed intent settles; only the person's retry can send another write.
            await act(async () => { await Promise.resolve(); });
            expect(home.paths.filter(path => path === '/v2/sessions/access-grants/set')).toHaveLength(1);
        },
    );

    it.each([undefined, RECIPIENT_ID])('admits manual preparation through its exact Action before sealing: %s', async recipient => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.granted = true;
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.encryption?.statusKey).toBe('ready'));
        const actionId = recipient === undefined ? 'session.access.encryption.prepare' : 'session.access.encryption.reprepare';
        const scope = createAccountSettingsScope(home.profile.id, MANAGER.accountId)!;
        storage.getState().applySettingsForScope(scope, settingsParse({ actionsSettingsV1: {
            v: 1, actions: { [actionId]: { disabledSurfaces: ['ui'] } },
        } }), 2);
        const reads = home.envelopeStates.length;
        home.state.envelopePages.push(
            { summary: { prepared: 0, pending: 1, invalid: 0, recipientKeyUnavailable: 0 }, items: [createRecipientEnvelopeItem()] },
            { summary: { prepared: 0, pending: 1, invalid: 0, recipientKeyUnavailable: 0 }, items: [createRecipientEnvelopeItem()] },
            { summary: { prepared: 1, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] },
            { summary: { prepared: 1, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] },
        );
        await act(async () => { controller().actions.prepareAccess(recipient); });
        await vi.waitFor(() => expect(controller().model.encryption?.statusKey).toBe('failed'));
        expect(home.state.uploaded).toBeNull();
        expect(home.envelopeStates).toHaveLength(reads);
        // A refused repair never withdraws the neighboring grant operation.
        await act(async () => { controller().actions.setAccessLevel({ kind: 'account', accountId: RECIPIENT_ID }, 'edit'); });
        await vi.waitFor(() => expect(home.state.grantAccessLevel).toBe('edit'));
        await vi.waitFor(() => expect(home.state.uploaded?.recipientAccountId).toBe(RECIPIENT_ID));
    });
    it('keeps a closed Share summary current without loading editor details, and retains its draft on reopen', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.granted = true;
        home.state.primaryTeamId = 'team-acme';
        TEAM_DIRECTORY.items = [{ id: 'team-acme', name: 'Acme',
            policy: { sessionCreationPolicy: 'team_default', externalSharingPolicy: 'allowed' } }];
        let latest: SessionAccessEditorController | null = null;
        const onRender = (controller: SessionAccessEditorController) => { latest = controller; };
        const screen = await renderScreen(<Probe serverId={home.profile.id} detailsDemanded={false} onRender={onRender} />);
        await vi.waitFor(() => expect(latest!.model.grants).toHaveLength(1));
        expect(home.envelopeStates).toHaveLength(0);
        expect(home.teamPaths).toHaveLength(0);
        expect(home.candidatePaths).toHaveLength(0);

        await screen.update(<Probe serverId={home.profile.id} detailsDemanded onRender={onRender} />);
        await vi.waitFor(() => expect(home.envelopeStates).toHaveLength(1));
        await vi.waitFor(() => expect(latest!.model.encryption?.statusKey).toBe('ready'));
        await vi.waitFor(() => expect(home.teamPaths).toHaveLength(1));
        await vi.waitFor(() => expect(home.candidatePaths.length).toBeGreaterThan(0));
        await act(async () => { latest!.actions.setQuery('Alice'); });
        await screen.update(<Probe serverId={home.profile.id} detailsDemanded={false} onRender={onRender} />);
        const detailCounts = [home.envelopeStates.length, home.teamPaths.length, home.candidatePaths.length];
        home.state.granted = false;
        await act(async () => { publishHomeAccountChange(home.profile.id, [SESSION_ID]); });
        await vi.waitFor(() => expect(latest!.model.grants).toHaveLength(0));
        expect([home.envelopeStates.length, home.teamPaths.length, home.candidatePaths.length]).toEqual(detailCounts);
        expect(latest!.query.read()).toBe('Alice');

        home.state.envelopePages.push({ summary: { prepared: 0, pending: 1, invalid: 0, recipientKeyUnavailable: 0 }, items: [] });
        await screen.update(<Probe serverId={home.profile.id} detailsDemanded onRender={onRender} />);
        await vi.waitFor(() => expect(home.envelopeStates.length).toBeGreaterThan(detailCounts[0]!));
        await vi.waitFor(() => expect(latest!.model.encryption?.statusKey).toBe('needs_attention'));
        expect(latest!.query.read()).toBe('Alice');
    });

    it('starts preparation for a replacement Session while the previous scope is still in flight', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.envelopePages = [
            { summary: { prepared: 0, pending: 1, invalid: 0, recipientKeyUnavailable: 0 }, items: [createRecipientEnvelopeItem()] },
            // Replacement Session discovery.
            { summary: { prepared: 0, pending: 1, invalid: 0, recipientKeyUnavailable: 0 }, items: [createRecipientEnvelopeItem()] },
            // Replacement Session preparation and its final recheck.
            { summary: { prepared: 0, pending: 1, invalid: 0, recipientKeyUnavailable: 0 }, items: [createRecipientEnvelopeItem()] },
            { summary: { prepared: 1, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] },
            // The settled replacement pass re-reads its exceptions.
            { summary: { prepared: 1, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] },
        ];
        let releasePreviousSession!: () => void;
        home.state.sessionSnapshotGates.set(SESSION_ID, new Promise<void>((resolve) => {
            releasePreviousSession = resolve;
        }));

        let latest: SessionAccessEditorController | null = null;
        const onRender = (controller: SessionAccessEditorController) => { latest = controller; };
        const screen = await renderScreen(<Probe serverId={home.profile.id} onRender={onRender} />);
        await vi.waitFor(() => expect(latest!.model.encryption?.actionLabel).toBe('Prepare now'));

        act(() => { latest!.actions.prepareAccess(); });
        await vi.waitFor(() => expect(home.paths).toContain(`/v2/sessions/${SESSION_ID}`));

        const replacementSessionId = 'replacement-session';
        await screen.update(<Probe serverId={home.profile.id} sessionId={replacementSessionId} onRender={onRender} />);
        await vi.waitFor(() => expect(latest!.model.encryption?.actionLabel).toBe('Prepare now'));
        act(() => { latest!.actions.prepareAccess(); });

        await vi.waitFor(() => expect(home.paths).toContain(`/v2/sessions/${replacementSessionId}`));
        await vi.waitFor(() => expect(latest!.model.encryption?.progressLabel).toBeUndefined());
        await act(async () => { releasePreviousSession(); });
    });

    it('keeps a plain Session free of encrypted-access warnings when discovery is not required', async () => {
        const home = await setupHome({ sharing: true, encrypted: true, sessionEncrypted: false });
        const controller = await mountController(home.profile.id);

        await vi.waitFor(() => expect(home.paths).toContain(`/v2/sessions/${SESSION_ID}/data-key/envelopes`));

        expect(controller().model.encryption).toBeUndefined();
        expect(controller().model.content.issue).toBeUndefined();
    });

    it('offers eligible ungranted Teams and confirms required-floor and external-policy consequences before mutation', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        TEAM_DIRECTORY.items = [{
            id: 'team-acme',
            name: 'Acme',
            policy: { sessionCreationPolicy: 'team_required', externalSharingPolicy: 'disabled' },
        }];
        const controller = await mountController(home.profile.id);

        expect(controller().model.context).toMatchObject({ primaryTeamId: null });
        await vi.waitFor(() => expect(controller().model.context?.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ teamId: 'team-acme', label: 'Acme' }),
        ])));
        expect(controller().model.grants).toHaveLength(0);
        await act(async () => { controller().actions.setContext('team-acme'); });
        expect(controller().model.context?.confirmation?.consequences).toEqual(expect.arrayContaining([
            t('session.access.required'),
            expect.stringContaining(t('teams.policy.externalSharingDisabled')),
        ]));
        expect(home.paths).not.toContain('/v2/sessions/access-context/set');
        await act(async () => { controller().actions.confirmContext(); });
        await vi.waitFor(() => expect(controller().model.context?.primaryTeamId).toBe('team-acme'));
        expect(home.paths).toContain('/v2/sessions/access-context/set');
        expect(home.teamPaths).toContain('/v1/teams/list');
    });

    it('keeps a successful context change quiet while its admitted policy is revalidated', async () => {
        const home = await setupHome({ sharing: true, encrypted: false });
        TEAM_DIRECTORY.items = [{
            id: 'team-acme',
            name: 'Acme',
            policy: { sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed' },
        }];
        let releasePolicyInspection = () => {};
        home.state.candidatePolicyGate = new Promise<void>((resolve) => { releasePolicyInspection = resolve; });
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.context?.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ teamId: 'team-acme', label: 'Acme' }),
        ])));

        act(() => { controller().actions.setContext('team-acme'); });
        await vi.waitFor(() => expect(controller().model.context?.primaryTeamId).toBe('team-acme'));
        await vi.waitFor(() => expect(home.candidatePaths).toHaveLength(1));

        expect(controller().model.notice).toBeUndefined();
        await act(async () => { releasePolicyInspection(); });
        await vi.waitFor(() => expect(controller().model.context?.operation).toBe('idle'));
        expect(controller().model.notice).toBeUndefined();
        expect(home.candidatePaths).toHaveLength(1);
    });

    it('keeps a typed context denial visible without changing the acknowledged context', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        TEAM_DIRECTORY.items = [{
            id: 'team-acme',
            name: 'Acme',
            policy: { sessionCreationPolicy: 'team_required', externalSharingPolicy: 'disabled' },
        }];
        home.state.contextMode = 'denied';
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.context?.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ teamId: 'team-acme' }),
        ])));

        await act(async () => { controller().actions.setContext('team-acme'); });
        await act(async () => { controller().actions.confirmContext(); });
        await vi.waitFor(() => expect(controller().model.context?.error?.code)
            .toBe('session_access_external_sharing_disabled'));

        expect(controller().model.context?.primaryTeamId).toBeNull();
        expect(controller().model.context?.error?.message).toContain(t('teams.policy.externalSharingDisabled'));
    });

    it('reconciles an unknown context response from the authoritative inspection', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        TEAM_DIRECTORY.items = [{
            id: 'team-acme',
            name: 'Acme',
            policy: { sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed' },
        }];
        home.state.contextMode = 'malformed_after_commit';
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.context?.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ teamId: 'team-acme' }),
        ])));

        await act(async () => { controller().actions.setContext('team-acme'); });
        await vi.waitFor(() => expect(controller().model.context?.primaryTeamId).toBe('team-acme'));

        expect(controller().model.context?.operation).toBe('idle');
        expect(controller().model.context?.error).toBeUndefined();
        expect(home.paths.filter((path) => path === '/v2/sessions/access-grants/list')).toHaveLength(2);
    });

    it('keeps an outcome-unknown context error when inspection disproves the requested change', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        TEAM_DIRECTORY.items = [{
            id: 'team-acme',
            name: 'Acme',
            policy: { sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed' },
        }];
        home.state.contextMode = 'malformed_without_commit';
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.context?.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ teamId: 'team-acme' }),
        ])));

        await act(async () => { controller().actions.setContext('team-acme'); });
        await vi.waitFor(() => expect(controller().model.context?.operation).toBe('error'));

        expect(controller().model.context?.primaryTeamId).toBeNull();
        expect(controller().model.context?.error).toMatchObject({
            code: 'outcome_unknown', retryable: true,
        });
    });

    it('allows Personal recovery when the current Team relaxed a stale required marker', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.primaryTeamId = 'team-acme';
        home.state.includeRequiredTeamGrant = true;
        TEAM_DIRECTORY.items = [{
            id: 'team-acme', name: 'Acme',
            policy: { sessionCreationPolicy: 'team_default', externalSharingPolicy: 'allowed' },
        }];
        const controller = await mountController(home.profile.id);

        await vi.waitFor(() => expect(controller().model.context?.options.find((option) => option.teamId === null)?.blockedReason)
            .toBeUndefined());
        act(() => { controller().actions.setContext(null); });
        await vi.waitFor(() => expect(controller().model.context?.primaryTeamId).toBeNull());
        expect(home.paths).toContain('/v2/sessions/access-context/set');
    });

    it('keeps an active team_required context locked from Personal and replacement Teams', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.primaryTeamId = 'team-acme';
        home.state.includeRequiredTeamGrant = true;
        TEAM_DIRECTORY.items = [
            { id: 'team-acme', name: 'Acme', policy: { sessionCreationPolicy: 'team_required', externalSharingPolicy: 'allowed' } },
            { id: 'team-design', name: 'Design', policy: { sessionCreationPolicy: 'team_default', externalSharingPolicy: 'allowed' } },
        ];
        const controller = await mountController(home.profile.id);

        await vi.waitFor(() => expect(controller().model.context?.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ teamId: null, blockedReason: expect.objectContaining({ code: 'session_access_team_policy_required' }) }),
            expect.objectContaining({ teamId: 'team-design', blockedReason: expect.objectContaining({ code: 'session_access_team_policy_required' }) }),
        ])));
        act(() => { controller().actions.setContext(null); });
        act(() => { controller().actions.setContext('team-design'); });
        expect(home.paths).not.toContain('/v2/sessions/access-context/set');
    });

    it('allows context recovery when the complete active Team directory no longer contains the current Team', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.primaryTeamId = 'team-acme';
        home.state.includeRequiredTeamGrant = true;
        home.state.contextArchived = true;
        const controller = await mountController(home.profile.id);

        await vi.waitFor(() => expect(controller().model.context?.options.find((option) => option.teamId === null)?.blockedReason)
            .toBeUndefined());
        act(() => { controller().actions.setContext(null); });
        await vi.waitFor(() => expect(controller().model.context?.primaryTeamId).toBeNull());
    });

    it('makes refused context-policy candidates unavailable and explains the archived Team by name', async () => {
        const home = await setupHome({ sharing: true, encrypted: false });
        home.state.primaryTeamId = 'team-acme';
        home.state.includeRequiredTeamGrant = true;
        home.state.contextArchived = true;
        TEAM_DIRECTORY.items = [{ id: 'team-design', name: 'Design', policy: {
            sessionCreationPolicy: 'team_default', externalSharingPolicy: 'allowed',
        } }];
        const controller = await mountController(home.profile.id);
        const candidates = await controller().model.directory.sections.find((section) => section.kind === 'team')!
            .resolveCandidates!('', new AbortController().signal);
        expect(candidates.find((row) => row.principal.key === 'team:team-design')?.addition).toMatchObject({
            kind: 'blocked', reason: { code: 'session_access_external_sharing_disabled', message: 'Acme is archived.' },
        });
        await vi.waitFor(() => expect(controller().model.context?.options.find((option) => option.teamId === 'team-acme'))
            .toMatchObject({ label: 'Acme', blockedReason: { message: 'Acme is archived.' } }));
        expect(controller().model.notice?.message).toBe('Acme is archived.');
        await act(async () => { controller().actions.addPrincipal({ kind: 'team', teamId: 'team-design' }); });
        expect(home.paths).not.toContain('/v2/sessions/access-grants/set');
    });

    it('uses the server candidate verdict rather than blocking every member under disabled outside sharing', async () => {
        const home = await setupHome({ sharing: true, encrypted: false });
        home.state.primaryTeamId = 'team-acme';
        TEAM_DIRECTORY.items = [
            { id: 'team-acme', name: 'Acme', policy: { sessionCreationPolicy: 'team_default', externalSharingPolicy: 'disabled' } },
            { id: 'team-design', name: 'Design', policy: { sessionCreationPolicy: 'team_default', externalSharingPolicy: 'allowed' } },
        ];
        const controller = await mountController(home.profile.id);
        const candidates = await controller().model.directory.sections.find((section) => section.kind === 'team')!
            .resolveCandidates!('', new AbortController().signal);
        expect(candidates.find((row) => row.principal.key === 'team:team-acme')?.addition).toEqual({ kind: 'allowed' });
        expect(candidates.find((row) => row.principal.key === 'team:team-design')?.addition.kind).toBe('blocked');
    });

    it('does not offer additions when an older Home cannot inspect the context policy', async () => {
        const home = await setupHome({ sharing: true, encrypted: false });
        home.state.primaryTeamId = 'team-acme';
        home.state.candidatePolicyUnavailable = true;
        TEAM_DIRECTORY.items = [{ id: 'team-design', name: 'Design', policy: { sessionCreationPolicy: 'team_default', externalSharingPolicy: 'allowed' } }];
        const controller = await mountController(home.profile.id);
        const candidates = await controller().model.directory.sections.find((section) => section.kind === 'team')!
            .resolveCandidates!('', new AbortController().signal);
        expect(candidates[0]?.addition).toMatchObject({ kind: 'blocked', reason: { code: 'session_access_context_policy_unavailable' } });
        expect(controller().model.notice?.message).toBeTruthy();
    });

    it('retains a missing context Team name from its Group grant while policy inspection is unavailable', async () => {
        const home = await setupHome({ sharing: true, encrypted: false });
        home.state.primaryTeamId = 'team-acme';
        home.state.includeContextGroupGrant = true;
        home.state.candidatePolicyUnavailable = true;
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.context?.options.find((option) => option.teamId === 'team-acme'))
            .toMatchObject({ label: 'Product Reliability', blockedReason: { code: 'session_access_context_policy_unavailable' } }));
    });

    it('fails closed while the exact current Team policy is transiently unknown', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.primaryTeamId = 'team-acme';
        home.state.includeRequiredTeamGrant = true;
        TEAM_DIRECTORY.failed = true;
        const controller = await mountController(home.profile.id);

        await vi.waitFor(() => expect(controller().model.context?.options.find((option) => option.teamId === null)?.blockedReason)
            .toMatchObject({ code: 'session_access_context_policy_unavailable' }));
        act(() => { controller().actions.setContext(null); });
        expect(home.paths).not.toContain('/v2/sessions/access-context/set');
    });

    it('starts the recipient-key pass only after the Home acknowledges the grant, and renders the Home summary', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.envelopePages = [
            { summary: { prepared: 0, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] },
            { summary: { prepared: 0, pending: 1, invalid: 0, recipientKeyUnavailable: 0 }, items: [createRecipientEnvelopeItem()] },
            { summary: { prepared: 0, pending: 1, invalid: 0, recipientKeyUnavailable: 0 }, items: [createRecipientEnvelopeItem()] },
            // The final recheck page is what the aggregate line must describe: other
            // recipients still need work that this pass did not discover in its slice.
            { summary: { prepared: 1, pending: 2, invalid: 0, recipientKeyUnavailable: 0 }, items: [] },
            // The settled pass re-reads the exceptions listed beneath the aggregate.
            { summary: { prepared: 1, pending: 2, invalid: 0, recipientKeyUnavailable: 0 }, items: [] },
        ];
        const controller = await mountController(home.profile.id);

        await act(async () => { controller().actions.addPrincipal({ kind: 'account', accountId: RECIPIENT_ID }); });
        await vi.waitFor(() => expect(controller().model.grants).toHaveLength(1));
        await vi.waitFor(() => expect(controller().model.encryption?.actionLabel).toBeDefined());

        // The direct envelope is prepared before the atomic grant, while the
        // broader audience pass follows the authoritative refresh.
        const sessionRead = home.paths.indexOf(`/v2/sessions/${SESSION_ID}`);
        const grantWrite = home.paths.indexOf('/v2/sessions/access-grants/set');
        const acknowledgedRefresh = home.paths.indexOf('/v2/sessions/access-grants/list', grantWrite + 1);
        const preparationRead = home.paths.indexOf(`/v2/sessions/${SESSION_ID}/data-key/envelopes`, acknowledgedRefresh + 1);
        const preparationWrite = home.paths.indexOf(`PATCH /v2/sessions/${SESSION_ID}/data-key/envelopes`);
        // Assert the user-visible security/lifecycle order without requiring an
        // incidental number of read-only policy or projection requests.
        expect(sessionRead).toBeGreaterThanOrEqual(0);
        expect(grantWrite).toBeGreaterThan(sessionRead);
        expect(acknowledgedRefresh).toBeGreaterThan(grantWrite);
        expect(preparationRead).toBeGreaterThan(acknowledgedRefresh);
        expect(preparationWrite).toBeGreaterThan(preparationRead);
        // The recipient really was sealed the Session's own key by the canonical owner.
        expect(home.state.uploaded?.recipientAccountId).toBe(RECIPIENT_ID);
        expect(home.state.directEnvelope).toEqual(expect.any(String));
        // One Session-scoped line from the Home's summary, not a count of grant rows:
        // the recheck reported one prepared and two still pending across the whole audience.
        expect(controller().model.encryption?.summaryLabel).toBe('1 prepared · 2 pending');
        expect(controller().model.encryption?.actionLabel).toBe('Prepare now');
        // The diagnostic is reachable from the mounted editor, not only from a defect.
        expect(controller().model.encryption?.showAllLabel).toBe('Show encryption per person');
        expect(controller().model.grants).toHaveLength(1);
        expect(controller().model.grants[0]?.operation).toEqual({ kind: 'idle' });
    });

    it('keeps an acknowledged grant successful when preparation fails', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.envelopeStatus = 500;
        const controller = await mountController(home.profile.id);

        await act(async () => { controller().actions.addPrincipal({ kind: 'account', accountId: RECIPIENT_ID }); });
        await vi.waitFor(() => expect(controller().model.grants).toHaveLength(1));
        await vi.waitFor(() => expect(controller().model.encryption).toBeDefined());

        // The grant committed. Only the separate encryption obligation failed.
        expect(controller().model.grants).toHaveLength(1);
        expect(controller().model.grants[0]?.operation).toEqual({ kind: 'idle' });
        expect(controller().model.content.issue).toBeUndefined();
        // The line names the key owner's own failure, so it stays distinguishable
        // from a grant failure the row would have to own instead.
        expect(controller().model.encryption?.error?.code).toBe('session_data_key_envelope_request_failed');
    });

    it('clears the typed search only after an add, never under a level change', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.granted = true;
        home.state.envelopePages.push({ summary: { prepared: 0, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] });
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.grants[0]?.level).toMatchObject({ value: 'view' }));

        await act(async () => { controller().actions.setQuery('ada'); });
        expect(controller().query.read()).toBe('ada');

        await act(async () => { controller().actions.setAccessLevel(GRANT_ROW.grant.subject, 'edit'); });
        await vi.waitFor(() => expect(controller().model.grants[0]?.level).toMatchObject({ value: 'edit' }));
        // Editing a live row is not a new search: the candidate list the user was
        // reading must not be rebuilt under the pointer.
        expect(controller().query.read()).toBe('ada');

        const operationBeforeAdd = controller().model.grants[0]?.operation;
        await act(async () => { controller().actions.addPrincipal({ kind: 'account', accountId: RECIPIENT_ID }); });
        try {
            await vi.waitFor(() => expect(controller().query.read()).toBe(''));
        } catch {
            const { runWithServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
            const { readSessionSnapshotForAuthority, SessionSnapshotReadError } = await import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority');
            const { serverFetch } = await import('@/sync/http/client');
            const snapshotProbe = await runWithServerRequestAuthorityForServerAccountScope({
                scope: { serverId: home.profile.id, accountId: MANAGER.accountId }, activeRequest: serverFetch,
            }, (authority) => readSessionSnapshotForAuthority({ authority, sessionId: SESSION_ID })).then(
                (snapshot) => ({ ok: true, sessionId: snapshot.session.id }),
                (error: unknown) => ({ ok: false, errorClass: error instanceof Error ? error.name : typeof error,
                    ...(error instanceof SessionSnapshotReadError ? { errorCode: error.errorCode, httpStatus: error.httpStatus }
                        : error instanceof Error ? { message: error.message } : {}) }),
            );
            expect(controller().query.read(), JSON.stringify({
                operationBeforeAdd, snapshotProbe, grants: controller().model.grants,
                issue: controller().model.content.issue, paths: home.paths,
            })).toBe('');
        }
    });

    it('settles a lost set response when the authoritative inspection proves the exact mutation committed', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.granted = true;
        home.state.grantMode = 'malformed_after_commit';
        home.state.envelopePages.push({ summary: { prepared: 0, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] });
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.grants[0]?.level).toMatchObject({ value: 'view' }));

        await act(async () => { controller().actions.setAccessLevel(GRANT_ROW.grant.subject, 'edit'); });
        await vi.waitFor(() => expect(controller().model.grants[0]?.level).toMatchObject({ value: 'edit' }));
        expect(controller().model.grants[0]?.operation).toEqual({ kind: 'idle' });
    });

    it('keeps a retryable row error when the authoritative inspection disproves the requested mutation', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.granted = true;
        home.state.grantMode = 'malformed_without_commit';
        home.state.envelopePages.push({ summary: { prepared: 0, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] });
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.grants[0]?.level).toMatchObject({ value: 'view' }));

        await act(async () => { controller().actions.setAccessLevel(GRANT_ROW.grant.subject, 'edit'); });
        await vi.waitFor(() => expect(controller().model.grants[0]?.operation.kind).toBe('error'));
        expect(controller().model.grants[0]?.level).toMatchObject({ value: 'view' });
        expect(controller().model.grants[0]?.operation).toMatchObject({
            kind: 'error', error: { code: 'outcome_unknown', retryable: true },
        });
    });

    it('retries the exact original mutation from the row-local recovery action', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.granted = true;
        home.state.grantMode = 'malformed_without_commit';
        home.state.envelopePages.push({ summary: { prepared: 0, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] });
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.grants[0]?.level).toMatchObject({ value: 'view' }));

        await act(async () => { controller().actions.setAccessLevel(GRANT_ROW.grant.subject, 'edit'); });
        await vi.waitFor(() => expect(controller().model.grants[0]?.operation.kind).toBe('error'));

        home.state.grantMode = 'normal';
        await act(async () => { controller().actions.retryMutation(GRANT_ROW.grant.subject); });
        await vi.waitFor(() => expect(controller().model.grants[0]?.level).toMatchObject({ value: 'edit' }));
        expect(controller().model.grants[0]?.operation).toEqual({ kind: 'idle' });
    });

    it('refreshes the aggregate but does not seal anything for an audience a revocation just made smaller', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.granted = true;
        home.state.envelopePages.push({ summary: { prepared: 0, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] });
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.grants).toHaveLength(1));

        await act(async () => { controller().actions.requestRemove(GRANT_ROW.grant.subject); });
        await act(async () => { controller().actions.confirmRemove(GRANT_ROW.grant.subject); });
        await vi.waitFor(() => expect(controller().model.grants).toHaveLength(0));

        // The removed recipient's stored tuple goes inert at the key owner. The
        // authoritative aggregate refreshes, but no key is opened and no page is patched.
        expect(home.paths.some((path) => path.startsWith('PATCH '))).toBe(false);
        expect(home.paths.filter((path) => path === `/v2/sessions/${SESSION_ID}`)).toHaveLength(0);
        // A healthy audience stays quiet: one ready line and no preparation action.
        expect(controller().model.encryption?.actionLabel).toBeUndefined();
        expect(controller().model.encryption?.summaryLabel).toBe('Ready for everyone with access');
    });

    it('refreshes an open editor when the exact Session is invalidated elsewhere, and ignores unrelated wakes', async () => {
        const home = await setupHome({ sharing: true, encrypted: true, sessionEncrypted: false });
        home.state.granted = true;
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.grants).toHaveLength(1));
        const listPath = '/v2/sessions/access-grants/list';
        const listsAfterMount = home.paths.filter((path) => path === listPath).length;

        // Another manager revoked this grant. The content-free Account-change wake
        // is the only hint; the authoritative list stays the access state owner.
        home.state.granted = false;
        await act(async () => { publishHomeAccountChange(home.profile.id, [SESSION_ID]); });
        await vi.waitFor(() => expect(controller().model.grants).toHaveLength(0));

        // A wake that names only other Sessions, or another Home entirely, must not
        // make this editor refetch its private roster.
        const listsAfterRevocation = home.paths.filter((path) => path === listPath).length;
        await act(async () => {
            publishHomeAccountChange(home.profile.id, ['some-other-session']);
            publishHomeAccountChange('another-home', [SESSION_ID]);
        });
        expect(home.paths.filter((path) => path === listPath)).toHaveLength(listsAfterRevocation);
        expect(listsAfterRevocation).toBeGreaterThan(listsAfterMount);
    });

    it('loads the all-people diagnostic only when asked, then pages and collapses it', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.granted = true;
        home.state.envelopePages.push(
            // The explicit diagnostic: healthy rows included, and more behind a cursor.
            { summary: { prepared: 2, pending: 0, invalid: 0, recipientKeyUnavailable: 0 },
                items: [{ ...createRecipientEnvelopeItem(), recipientAccountId: 'first', envelopeState: 'prepared' }],
                nextCursor: encodeSessionDataKeyEnvelopeCursorV1('first') },
            { summary: { prepared: 2, pending: 0, invalid: 0, recipientKeyUnavailable: 0 },
                items: [{ ...createRecipientEnvelopeItem(), recipientAccountId: 'second', envelopeState: 'prepared' }] },
        );
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.encryption).toBeDefined());

        // Discovery never asks for healthy rows: the aggregate alone drives the line.
        expect(home.envelopeStates).toEqual(['action_required']);
        expect(controller().model.encryption?.recipients).toBeUndefined();

        await act(async () => { controller().actions.toggleAllRecipients(); });
        await vi.waitFor(() => expect(controller().model.encryption?.recipients?.rows).toHaveLength(1));
        expect(home.envelopeStates).toEqual(['action_required', 'all']);
        expect(controller().model.encryption?.recipients?.hasMore).toBe(true);
        expect(controller().model.encryption?.showAllLabel).toBe('Hide encryption per person');

        await act(async () => { controller().actions.loadMoreRecipients(); });
        await vi.waitFor(() => expect(controller().model.encryption?.recipients?.rows).toHaveLength(2));
        expect(controller().model.encryption?.recipients?.rows.map((row) => row.recipientAccountId))
            .toEqual(['first', 'second']);
        expect(controller().model.encryption?.recipients?.hasMore).toBe(false);

        // The mounted controller carries an exact repair intent through the real crypto/API
        // owner. The selected prepared recipient is behind another diagnostic page, and the
        // final diagnostic recheck still contains healthy rows after the acknowledged write.
        const firstPage: EnvelopePage = {
            summary: { prepared: 2, pending: 0, invalid: 0, recipientKeyUnavailable: 0 },
            items: [{ ...createRecipientEnvelopeItem(), recipientAccountId: 'first', envelopeState: 'prepared' }],
            nextCursor: encodeSessionDataKeyEnvelopeCursorV1('first'),
        };
        home.state.envelopePages.push(firstPage, {
            summary: firstPage.summary,
            items: [{ ...createRecipientEnvelopeItem(), recipientAccountId: 'second', envelopeState: 'prepared' }],
        }, firstPage, firstPage);
        await act(async () => { controller().actions.prepareAccess('second'); });
        await vi.waitFor(() => expect(home.state.uploaded?.recipientAccountId).toBe('second'));
        await vi.waitFor(() => expect(controller().model.encryption?.progressLabel).toBeUndefined());
        // The open view is re-read once the pass settles, through the same `all` transport.
        await vi.waitFor(() => expect(home.envelopeStates.slice(-4)).toEqual(['all', 'all', 'all', 'all']));
        expect(home.paths.filter(path => path === `PATCH /v2/sessions/${SESSION_ID}/data-key/envelopes`)).toHaveLength(1);
        expect(controller().model.encryption?.error).toBeUndefined();

        // Hiding the all-people view re-reads the current exceptions rather than
        // rendering an audience that may have changed meanwhile.
        home.state.envelopePages.push({ summary: { prepared: 2, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] });
        await act(async () => { controller().actions.toggleAllRecipients(); });
        await vi.waitFor(() => expect(controller().model.encryption?.recipients).toBeUndefined());
        expect(home.envelopeStates.at(-1)).toBe('action_required');
        expect(controller().model.encryption?.showAllLabel).toBe('Show encryption per person');
    });

    it('batches 500 Team recipients only in the visible census and resolves just the next page', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.granted = true;
        home.state.includeRequiredTeamGrant = true;
        home.state.additionalTeamIds = ['team-design'];
        const item = createRecipientEnvelopeItem();
        const accountIds = Array.from({ length: 500 }, (_, index) => `recipient-${index}`);
        TEAM_MEMBER_LOOKUPS.members = [...accountIds.slice(0, -1), 'second-page'].map(accountId => ({
            accountId, account: { name: `Team ${accountId}`, firstName: 'Team', lastName: accountId, username: accountId, avatarUrl: null },
        }));
        const page = {
            summary: { prepared: 0, pending: 501, invalid: 0, recipientKeyUnavailable: 0 },
            items: accountIds.map(recipientAccountId => ({ ...item, recipientAccountId })),
            nextCursor: encodeSessionDataKeyEnvelopeCursorV1(accountIds.at(-1)!),
        };
        home.state.envelopePages = [page, page, {
            summary: page.summary, items: [{ ...item, recipientAccountId: 'second-page' }],
        }];
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.encryption?.recipients?.rows).toHaveLength(500));
        expect(TEAM_MEMBER_LOOKUPS.queries).toEqual([]);
        expect(TEAM_MEMBER_LOOKUPS.principalBatches).toEqual([]);
        await act(async () => { controller().actions.toggleAllRecipients(); });
        await vi.waitFor(() => expect(controller().model.encryption?.recipients?.rows[0]?.label).toBe('Team recipient-0'));
        expect(controller().model.encryption?.recipients?.rows[499]?.label).toBe('recipient-499');
        expect(TEAM_MEMBER_LOOKUPS.principalBatches).toEqual([accountIds]);
        await act(async () => { controller().actions.loadMoreRecipients(); });
        await vi.waitFor(() => expect(controller().model.encryption?.recipients?.rows[500]?.label).toBe('Team second-page'));
        expect(TEAM_MEMBER_LOOKUPS.principalBatches).toEqual([accountIds, ['second-page']]);
        expect(TEAM_MEMBER_LOOKUPS.queries).toEqual([]);
    });

    it('cancels recipient identity disclosure when the census closes', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.includeRequiredTeamGrant = true;
        let release!: () => void;
        TEAM_MEMBER_LOOKUPS.principalGate = new Promise<void>(resolve => { release = resolve; });
        TEAM_MEMBER_LOOKUPS.members = [{ accountId: 'carol',
            account: { name: 'Carol Shaw', firstName: 'Carol', lastName: 'Shaw', username: 'carol', avatarUrl: null } }];
        home.state.envelopePages.push({ summary: { prepared: 0, pending: 1, invalid: 0, recipientKeyUnavailable: 0 },
            items: [{ ...createRecipientEnvelopeItem(), recipientAccountId: 'carol' }] },
        { summary: { prepared: 0, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] });
        const controller = await mountController(home.profile.id);
        await act(async () => { controller().actions.toggleAllRecipients(); });
        await vi.waitFor(() => expect(TEAM_MEMBER_LOOKUPS.principalBatches).toEqual([['carol']]));
        await act(async () => { controller().actions.toggleAllRecipients(); });
        expect(TEAM_MEMBER_LOOKUPS.principalSignals[0]?.aborted).toBe(true);
        await act(async () => { release(); });
        expect(controller().model.encryption?.recipients).toBeUndefined();
    });

    it('settles an acknowledged no-op grant without refreshing or preparing keys', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.granted = true;
        home.state.mutationChanged = false;
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.encryption).toBeDefined());
        const reads = home.paths.filter(path => path === '/v2/sessions/access-grants/list').length;
        const envelopeReads = home.envelopeStates.length;
        await act(async () => { controller().actions.setAccessLevel(GRANT_ROW.grant.subject, 'view'); });
        await vi.waitFor(() => expect(home.paths).toContain('/v2/sessions/access-grants/set'));
        await vi.waitFor(() => expect(controller().model.grants[0]?.operation.kind).toBe('idle'));
        expect(home.paths.filter(path => path === '/v2/sessions/access-grants/list')).toHaveLength(reads);
        expect(home.envelopeStates).toHaveLength(envelopeReads);
    });

    it('refreshes a no-op grant when its acknowledged values differ from the retained row', async () => {
        const home = await setupHome({ sharing: true, encrypted: false });
        home.state.granted = true;
        home.state.mutationChanged = false;
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.grants[0]?.level).toMatchObject({ value: 'view' }));
        const reads = home.paths.filter(path => path === '/v2/sessions/access-grants/list').length;
        home.state.grantAccessLevel = 'edit';
        await act(async () => { controller().actions.setAccessLevel(GRANT_ROW.grant.subject, 'edit'); });
        await vi.waitFor(() => expect(controller().model.grants[0]?.level).toMatchObject({ value: 'edit' }));
        expect(home.paths.filter(path => path === '/v2/sessions/access-grants/list')).toHaveLength(reads + 1);
    });

    it.each(['remove', 'context'] as const)('consumes a no-op %s acknowledgement already reconciled by the Home wake', async kind => {
        const home = await setupHome({ sharing: true, encrypted: false });
        home.state.granted = true;
        home.state.mutationChanged = false;
        TEAM_DIRECTORY.items = [{ id: 'team-acme', name: 'Acme', policy: {
            sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
        } }];
        let release!: () => void;
        home.state.mutationGate = new Promise<void>(resolve => { release = resolve; });
        const controller = await mountController(home.profile.id);
        if (kind === 'remove') {
            home.state.granted = false;
            act(() => { controller().actions.requestRemove(GRANT_ROW.grant.subject); });
            await act(async () => { controller().actions.confirmRemove(GRANT_ROW.grant.subject); });
        } else {
            await vi.waitFor(() => expect(controller().model.context?.options).toEqual(expect.arrayContaining([
                expect.objectContaining({ teamId: 'team-acme' }),
            ])));
            home.state.primaryTeamId = 'team-acme';
            await act(async () => { controller().actions.setContext('team-acme'); });
        }
        const mutationPath = kind === 'remove' ? '/v2/sessions/access-grants/remove' : '/v2/sessions/access-context/set';
        await vi.waitFor(() => expect(home.paths).toContain(mutationPath));
        // Another device's committed transition is already visible before this
        // idempotent request's acknowledgement arrives.
        await act(async () => { publishHomeAccountChange(home.profile.id, [SESSION_ID]); });
        await vi.waitFor(() => kind === 'remove'
            ? expect(controller().model.grants).toHaveLength(0)
            : expect(controller().model.context?.primaryTeamId).toBe('team-acme'));
        const reads = home.paths.filter(path => path === '/v2/sessions/access-grants/list').length;
        await act(async () => { release(); });
        if (kind === 'context') await vi.waitFor(() => expect(controller().model.context?.operation).toBe('idle'));
        expect(home.paths.filter(path => path === '/v2/sessions/access-grants/list')).toHaveLength(reads);
    });

    it('lists the discovered exceptions beneath the aggregate by default and re-reads them after a pass', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.granted = true;
        home.state.envelopePages = [
            // Discovery already carries the exception rows the aggregate counts.
            { summary: { prepared: 0, pending: 1, invalid: 0, recipientKeyUnavailable: 0 }, items: [createRecipientEnvelopeItem()] },
        ];
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.encryption?.recipients?.rows).toHaveLength(1));

        // No second request: the default expansion is the discovery page itself.
        expect(home.envelopeStates).toEqual(['action_required']);
        expect(controller().model.encryption?.recipients?.rows[0]).toMatchObject({
            recipientAccountId: RECIPIENT_ID, state: 'pending', label: 'Alice',
        });
        expect(controller().model.encryption?.recipients?.hasMore).toBe(false);
        expect(controller().model.encryption?.showAllLabel).toBe('Show encryption per person');

        // The pass seals the pending recipient; the rows beneath the aggregate must
        // then say what the Home says now, not what discovery said before the pass.
        home.state.envelopePages.push(
            { summary: { prepared: 0, pending: 1, invalid: 0, recipientKeyUnavailable: 0 }, items: [createRecipientEnvelopeItem()] },
            { summary: { prepared: 1, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] },
            { summary: { prepared: 1, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] },
        );
        await act(async () => { controller().actions.prepareAccess(); });
        await vi.waitFor(() => expect({ uploaded: home.state.uploaded?.recipientAccountId,
            preparationError: controller().model.encryption?.error }).toMatchObject({ uploaded: RECIPIENT_ID }));
        await vi.waitFor(() => expect(controller().model.encryption?.summaryLabel).toBe('Ready for everyone with access'));
        await vi.waitFor(() => expect(controller().model.encryption?.recipients).toBeUndefined());
        expect(home.envelopeStates.at(-1)).toBe('action_required');
    });
});

/**
 * The Account's own explicit choice, in the canonical Actions settings owner, to
 * confirm these in-app Actions — activated for the live Account the way the sync
 * owner activates it (`activateAccountSettingsScope`: settings and profile scopes
 * together), which is what lets the approval writer publish the settled Artifact
 * to the mounted continuation.
 */
async function requireSharedActionConfirmation(scope: Readonly<{ serverId: string; accountId: string }>, actionIds: readonly string[]) {
    const settingsScope = createAccountSettingsScope(scope.serverId, scope.accountId);
    if (!settingsScope) throw new Error('The settings scope owner rejected this Home/Account pair');
    storage.getState().applySettingsForScope(settingsScope, {
        ...settingsParse({}),
        actionsSettingsV1: {
            v: 1,
            actions: Object.fromEntries(actionIds.map((actionId) => [actionId, {
                enabledPlacements: [], disabledSurfaces: [], disabledPlacements: [],
                approvalRequiredSurfaces: ['ui'], toolExposureModes: {},
            }])),
            approvalWaivedSurfaces: {},
        },
    // A later settings version than the waiver `setupHome` stored: the scoped
    // settings owner accepts only a newer version.
    }, 2);
    await storage.getState().activateSettingsScope(settingsScope, []);
    storage.getState().activateProfileScope(settingsScope, []);
}

/** The ids of the approval Artifacts this Home persisted, in creation order. */
function approvalIds(home: Readonly<{ artifacts: ReturnType<typeof createArtifactStoreBoundary> }>): string[] {
    return home.artifacts.list().map((row) => row.id);
}

// teams-lane-04-session-access-sharing-authorship-presence.md §5: "Pending Action
// approval, known rejection, unknown outcome ... are rendered and recoverable."
//
// The Account is E2EE: the approval is sealed by the real Artifact codec, stored by
// the Home's stateful Artifact routes, decided through the Inbox's generic executor,
// and observed by the editor through the real approval reader.
describe('useLiveSessionAccessEditorController deferred approval', () => {
    it('cancels manual preparation without losing the acknowledged encryption state or writing an envelope', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        await requireSharedActionConfirmation({ serverId: home.profile.id, accountId: MANAGER.accountId }, ['session.access.encryption.prepare']);
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.encryption?.statusKey).toBe('ready'));
        const reads = home.envelopeStates.length;
        await act(async () => { controller().actions.prepareAccess(); });
        await vi.waitFor(() => expect(controller().model.pendingApproval).toBeDefined());
        expect((await decideApprovalAsInbox(home.profile.id, approvalIds(home)[0]!, 'cancel')).ok).toBe(true);
        await vi.waitFor(() => expect(controller().model.pendingApproval).toBeUndefined());
        expect(controller().model.encryption?.statusKey).toBe('ready');
        expect(home.state.uploaded).toBeNull();
        expect(home.envelopeStates).toHaveLength(reads);
    });
    it.each([undefined, RECIPIENT_ID])('settles a manual preparation approval through the real client family owner: %s', async recipient => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.granted = true;
        const actionId = recipient === undefined ? 'session.access.encryption.prepare' : 'session.access.encryption.reprepare';
        await requireSharedActionConfirmation({ serverId: home.profile.id, accountId: MANAGER.accountId }, [actionId]);
        const controller = await mountController(home.profile.id);
        await vi.waitFor(() => expect(controller().model.encryption?.statusKey).toBe('ready'));
        home.state.envelopePages.push(
            { summary: { prepared: 0, pending: 1, invalid: 0, recipientKeyUnavailable: 0 }, items: [createRecipientEnvelopeItem()] },
            { summary: { prepared: 1, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] },
            { summary: { prepared: 1, pending: 0, invalid: 0, recipientKeyUnavailable: 0 }, items: [] },
        );
        await act(async () => { controller().actions.prepareAccess(recipient); });
        await vi.waitFor(() => {
            expect(controller().model.encryption?.error).toBeUndefined();
            expect(controller().model.pendingApproval).toBeDefined();
        });
        expect(controller().model.encryption?.statusKey).toBe('ready');
        expect(home.state.uploaded).toBeNull();
        const decision = await decideApprovalAsInbox(home.profile.id, approvalIds(home)[0]!, 'approve');
        expect(decision.ok).toBe(true);
        await vi.waitFor(() => expect(home.state.uploaded?.recipientAccountId).toBe(RECIPIENT_ID));
        await vi.waitFor(() => expect(controller().model.pendingApproval).toBeUndefined());
        expect(approvalIds(home)).toHaveLength(1);
    });

    it('renders an approval-routed add as pending, holds further edits, and applies the executed approval once', async () => {
        const home = await setupHome({ sharing: true, encrypted: true, sessionEncrypted: false });
        await requireSharedActionConfirmation({ serverId: home.profile.id, accountId: MANAGER.accountId }, ['session.access.grant.set']);
        const controller = await mountController(home.profile.id);

        await act(async () => { controller().actions.addPrincipal({ kind: 'account', accountId: RECIPIENT_ID }); });
        await vi.waitFor(() => expect(approvalIds(home)).toHaveLength(1));
        const approvalId = approvalIds(home)[0]!;
        // An E2EE Account's approval never reaches its Home as plaintext.
        expect(home.artifacts.readPlainBody(approvalId)).toBeNull();
        await vi.waitFor(() => expect(controller().model.pendingApproval).toEqual({
            artifactId: approvalId, serverId: home.profile.id,
        }));
        // The real front door routed the intent to an approval: nothing reached the
        // grant writer, nothing is committed, and it is not an unknown outcome.
        expect(home.paths).not.toContain('/v2/sessions/access-grants/set');
        expect(controller().model.grants).toHaveLength(0);
        expect(controller().model.content.issue).toBeUndefined();

        // One approval at a time: a second intent is held, not silently submitted.
        await act(async () => { controller().actions.addPrincipal({ kind: 'account', accountId: RECIPIENT_ID }); });
        expect(approvalIds(home)).toEqual([approvalId]);

        // The Inbox approves: its replay is the one grant write on the Home.
        const decision = await decideApprovalAsInbox(home.profile.id, approvalId, 'approve');
        expect(decision, JSON.stringify(decision)).toMatchObject({
            ok: true, result: { status: 'executed' },
        });
        await vi.waitFor(() => expect(controller().model.grants).toHaveLength(1));
        expect(controller().model.pendingApproval).toBeUndefined();
        expect(controller().model.grants[0]?.operation).toEqual({ kind: 'idle' });
        expect(home.paths.filter((path) => path === '/v2/sessions/access-grants/set')).toHaveLength(1);
    });

    it('releases the pending state without any change when the approval is rejected', async () => {
        const home = await setupHome({ sharing: true, encrypted: true, sessionEncrypted: false });
        await requireSharedActionConfirmation({ serverId: home.profile.id, accountId: MANAGER.accountId }, ['session.access.grant.set']);
        const controller = await mountController(home.profile.id);

        await act(async () => { controller().actions.addPrincipal({ kind: 'account', accountId: RECIPIENT_ID }); });
        await vi.waitFor(() => expect(approvalIds(home)).toHaveLength(1));
        const approvalId = approvalIds(home)[0]!;
        await vi.waitFor(() => expect(controller().model.pendingApproval?.artifactId).toBe(approvalId));

        const decision = await decideApprovalAsInbox(home.profile.id, approvalId, 'reject');
        expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
        await vi.waitFor(() => expect(controller().model.pendingApproval).toBeUndefined());
        expect(controller().model.grants).toHaveLength(0);
        expect(controller().model.content.issue).toBeUndefined();
        expect(home.paths).not.toContain('/v2/sessions/access-grants/set');

        // The editor is usable again: the next intent opens a fresh approval.
        await act(async () => { controller().actions.addPrincipal({ kind: 'account', accountId: RECIPIENT_ID }); });
        await vi.waitFor(() => expect(approvalIds(home)).toHaveLength(2));
        await vi.waitFor(() => expect(controller().model.pendingApproval?.artifactId).toBe(approvalIds(home)[1]));
    });
});

// PA-L2: "Reachable layout-0 Sessions migrate through the canonical owner/tuple CAS
// before sharing or other non-owner projection. There is no background sweep."
describe('useLiveSessionAccessEditorController historical (0.2) Session', () => {
    /** Metadata exactly as a 0.2 client wrote it: one bag mixing presentation with machine-local owner facts. */
    const PREDECESSOR_METADATA = {
        path: '/Users/owner/private-repo',
        host: 'owner-laptop',
        os: 'darwin',
        machineId: 'machine-owner',
        summary: { text: 'Historical shared work', updatedAt: 42 },
        claudeSessionId: 'claude-private-session',
    };

    async function storePredecessorSession(home: Awaited<ReturnType<typeof setupHome>>) {
        const { AES256Encryption } = await import('@/sync/encryption/encryptor');
        const cipher = new AES256Encryption(home.sessionDataKey);
        const [metadata, agentState] = await cipher.encrypt([PREDECESSOR_METADATA, { controlledByUser: false }]);
        if (!MANAGER.keys) throw new Error('Expected the owner content key pair');
        home.state.predecessorSession = {
            id: SESSION_ID, createdAt: 1, updatedAt: 2, seq: 3, active: false, activeAt: 2,
            encryptionMode: 'e2ee',
            dataEncryptionKey: encryptDataKeyForRecipientV0(home.sessionDataKey, encodeBase64(MANAGER.keys.publicKey, 'base64')),
            metadataLayoutVersion: 0, metadataVersion: 4, metadata: encodeBase64(metadata!, 'base64'),
            agentStateVersion: 5, agentState: encodeBase64(agentState!, 'base64'), share: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: CAPABILITIES },
            responsibleAccountId: null, responsibleAccount: null,
        };
    }

    it('refuses an explicitly disabled layout Update before the tuple writer and leaves grant admission available', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        await storePredecessorSession(home);
        const controller = await mountController(home.profile.id, { metadataLayoutVersion: 0 });
        const scope = createAccountSettingsScope(home.profile.id, MANAGER.accountId)!;
        storage.getState().applySettingsForScope(scope, settingsParse({ actionsSettingsV1: {
            v: 1, actions: { 'session.access.layout.update': { disabledSurfaces: ['ui'] } },
        } }), 2);
        await act(async () => { controller().actions.updateHistoricalLayout?.(); });
        await vi.waitFor(() => expect(controller().model.historicalLayout?.error).toBeDefined());
        expect(home.state.metadataPatches).toHaveLength(0);
        const { createSessionAccessClient } = await import('@/sync/api/session/sessionAccessApi');
        await expect(createSessionAccessClient({ scope: { serverId: home.profile.id, accountId: MANAGER.accountId },
            sessionId: SESSION_ID, availability: 'available' }).list()).resolves.toHaveProperty('grants');
    });

    it('does not migrate a historical Session before a refused grant enters admission', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        home.state.granted = true;
        await storePredecessorSession(home);
        const controller = await mountController(home.profile.id, { metadataLayoutVersion: 0 });
        const scope = createAccountSettingsScope(home.profile.id, MANAGER.accountId)!;
        storage.getState().applySettingsForScope(scope, settingsParse({ actionsSettingsV1: {
            v: 1, actions: { 'session.access.grant.set': { disabledSurfaces: ['ui'] } },
        } }), 2);
        await act(async () => { controller().actions.setAccessLevel({ kind: 'account', accountId: RECIPIENT_ID }, 'edit'); });
        // Wait for the attempted row to settle so an asynchronous pre-admission
        // migration cannot satisfy an early negative assertion.
        await vi.waitFor(() => expect(controller().model.grants[0]?.operation.kind).toBe('error'));
        expect(home.state.metadataPatches).toHaveLength(0);
        expect(home.state.grantAccessLevel).toBe('view');
    });

    it('keeps the historical layout offer when its Update approval is rejected', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        await storePredecessorSession(home);
        await requireSharedActionConfirmation({ serverId: home.profile.id, accountId: MANAGER.accountId }, ['session.access.layout.update']);
        const controller = await mountController(home.profile.id, { metadataLayoutVersion: 0 });
        await act(async () => { controller().actions.updateHistoricalLayout?.(); });
        await vi.waitFor(() => expect(controller().model.pendingApproval).toBeDefined());
        expect((await decideApprovalAsInbox(home.profile.id, approvalIds(home)[0]!, 'reject')).ok).toBe(true);
        await vi.waitFor(() => expect(controller().model.pendingApproval).toBeUndefined());
        expect(controller().model.historicalLayout).toEqual({ updating: false });
        expect(home.state.metadataPatches).toHaveLength(0);
    });

    it('offers its owner an explicit update that splits it through the one tuple owner without changing content', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        await storePredecessorSession(home);
        await requireSharedActionConfirmation({ serverId: home.profile.id, accountId: MANAGER.accountId }, ['session.access.layout.update']);
        const controller = await mountController(home.profile.id, { metadataLayoutVersion: 0 });
        await vi.waitFor(() => expect(controller().model.historicalLayout).toEqual({ updating: false }));

        await act(async () => { controller().actions.updateHistoricalLayout?.(); });
        await vi.waitFor(() => {
            expect(controller().model.historicalLayout?.error).toBeUndefined();
            expect(controller().model.pendingApproval).toBeDefined();
        });
        expect(controller().model.historicalLayout?.updating).toBe(false);
        expect(home.state.metadataPatches).toHaveLength(0);
        expect((await decideApprovalAsInbox(home.profile.id, approvalIds(home)[0]!, 'approve')).ok).toBe(true);
        await vi.waitFor(() => expect(home.paths).toContain(`PATCH /v2/sessions/${SESSION_ID}`));
        await vi.waitFor(() => expect(controller().model.historicalLayout).toBeUndefined());

        expect(home.state.metadataPatches).toHaveLength(1);
        const patch = home.state.metadataPatches[0] as {
            mode: string;
            source: { metadataLayoutVersion: number; metadata: { version: number }; agentState: { version: number } };
            target: { metadataLayoutVersion: number; sharedMetadata: { ciphertext: string }; ownerMetadata: unknown };
        };
        // Exact CAS from the stored predecessor tuple; nothing but the split changes.
        expect(patch.mode).toBe('owner_migration');
        expect(patch.source).toMatchObject({ metadataLayoutVersion: 0, metadata: { version: 4 }, agentState: { version: 5 } });
        expect(patch.target.metadataLayoutVersion).toBe(1);
        // Recipients receive only the strict shared projection; owner-private facts
        // stay in the owner's own envelope.
        const { AES256Encryption } = await import('@/sync/encryption/encryptor');
        const { decodeBase64 } = await import('@/encryption/base64');
        const [shared] = await new AES256Encryption(home.sessionDataKey).decrypt([decodeBase64(patch.target.sharedMetadata.ciphertext, 'base64')]);
        expect(shared).toMatchObject({ summary: { text: 'Historical shared work' } });
        expect(JSON.stringify(shared)).not.toContain('/Users/owner/private-repo');
        expect(JSON.stringify(shared)).not.toContain('owner-laptop');
        expect(JSON.stringify(shared)).not.toContain('claude-private-session');
        expect(patch.target.ownerMetadata).toBeTruthy();
    });

    it('splits the Session before a new share reaches the grant writer', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        await storePredecessorSession(home);
        const controller = await mountController(home.profile.id, { metadataLayoutVersion: 0 });

        await act(async () => { controller().actions.addPrincipal({ kind: 'account', accountId: RECIPIENT_ID }); });
        await vi.waitFor(() => expect(controller().model.grants).toHaveLength(1));
        expect(home.state.metadataPatches).toHaveLength(1);
        expect(home.paths.indexOf(`PATCH /v2/sessions/${SESSION_ID}`))
            .toBeLessThan(home.paths.indexOf('/v2/sessions/access-grants/set'));
        expect(controller().model.historicalLayout).toBeUndefined();
    });

    it('offers nothing to a Session already on the current layout, or when its layout is unknown', async () => {
        const home = await setupHome({ sharing: true, encrypted: true });
        const current = await mountController(home.profile.id, { metadataLayoutVersion: 1 });
        expect(current().model.historicalLayout).toBeUndefined();
        const unknown = await mountController(home.profile.id);
        expect(unknown().model.historicalLayout).toBeUndefined();
    });
});
