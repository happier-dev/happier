import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1,
    SessionPublicLinkCreateActionResultV1Schema,
    SessionOwnerMetadataV1Schema,
    tryWriteServerEnabledBitInPlace,
} from '@happier-dev/protocol';

// Imported from their owning testkit modules, never the `@/dev/testkit` barrel:
// the harness installs its network boundaries with `vi.doMock`, which only
// reaches modules imported afterwards (see `installHomeGovernanceBoundaries`).
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { ExternalSessionSharingAvailability } from '@/components/sessions/external/sharing/useExternalSessionSharingAvailability';
import type { Session } from '@/sync/domains/state/storageTypes';

/**
 * An approval-routed public-link publication, end to end.
 *
 * teams-lane-04 umbrella §5: "Pending Action approval, known rejection, unknown
 * outcome ... are rendered and recoverable." The section's real controller asks
 * the shared Action front door, which persists an open approval in the Home's
 * stateful Artifact store; the Inbox decides it through the generic executor,
 * whose replay is the one publication request; and the section settles only
 * through the real approval reader and the authoritative publication read.
 * The network, the credential store, the platform view layer and the modal host
 * are the only replaced boundaries; the person's submit is the card's own Create.
 */

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const modal = vi.hoisted(() => ({ update: vi.fn(), hide: vi.fn(), alert: vi.fn() }));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: modal }).module;
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const ACCOUNT_ID = 'account-owner';
const SESSION_ID = 'session-1';
const PUBLIC_SHARE_PATH = `/v1/sessions/${SESSION_ID}/public-share`;
const PUBLIC_SHARE_CREATE_PATH = '/v1/public-shares';

function session(): Session {
    return {
        id: SESSION_ID,
        metadata: null,
        // A Session a current Home created: the canonical reader always names its
        // persisted layout, so no owner migration precedes publication.
        metadataLayoutVersion: 1,
        currentStorageState: 'hosted',
        transcriptShareable: true,
        access: { capabilities: { managePublicLink: true } },
    } as unknown as Session;
}

function hostedAvailability(): ExternalSessionSharingAvailability {
    return {
        sharingPresentation: {
            shareable: true,
            state: 'hosted',
            machineName: null,
            action: 'none',
            materializedThroughSourceAt: null,
        },
    } as unknown as ExternalSessionSharingAvailability;
}

/**
 * The plain Session exactly as a current Home serves it by id: layout 1, its
 * shared projection and owner metadata produced by their own protocol owners.
 * Publication materialization reads it on replay to decide whether a Session key
 * must be sealed to the new bearer; a plain Session needs none.
 */
function plainSessionRow() {
    const sharedMetadata = projectSessionSharedMetadataV1({
        metadata: { path: '/work/project', machineId: 'machine-1', summary: { text: 'Release', updatedAt: 1 } },
        agentState: null,
    });
    const ownerMetadata = createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({
        v: 1,
        workspace: { path: '/work/project', machineId: 'machine-1' },
    }));
    return {
        id: SESSION_ID, createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
        encryptionMode: 'plain', dataEncryptionKey: null,
        metadataLayoutVersion: 1, metadataVersion: 4, metadata: JSON.stringify(sharedMetadata),
        ownerMetadata,
        agentStateVersion: 5, agentState: null, share: null,
        effectiveAccess: {
            v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: {
                readTranscript: true, submitAgentInput: true, editSessionRecords: true,
                approveRuntimePermissions: true, manageAccess: true, managePermissionDelegation: true,
                managePublicLink: true, archiveSession: true, renameSession: true,
                assignResponsibility: true, stopSession: true, deleteSession: true,
            },
        },
        responsibleAccountId: null, responsibleAccount: null,
    };
}

/** One Home publishing `sharing.public`, whose Account requires approval for a new public link. */
async function addPublishingHome(): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home One',
        serverUrl: 'https://publication-home.example',
        publicServerUrl: 'https://public-home.example',
        accountId: ACCOUNT_ID,
    });
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sharing.public', true)) {
        throw new Error('The sharing.public feature bit could not be written by its own writer');
    }
    harness.answer(serverId, '/v1/features', { body: features });
    harness.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    await harness.requireUiApproval(serverId, 'session.public_link.create');
    harness.answer(serverId, `GET ${PUBLIC_SHARE_PATH}`, { body: { publicShare: null } });
    // The Plain Account's own currentness, which the by-id reader consults before
    // it opens a layout-1 Session's owner metadata.
    harness.answer(serverId, '/v1/account/encryption/currentness', {
        body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
        },
    });
    harness.answer(serverId, `/v2/sessions/${SESSION_ID}`, { body: { session: plainSessionRow() } });
    harness.answer(serverId, `/v2/sessions/${SESSION_ID}?accessProjectionVersion=1`, { body: { session: plainSessionRow() } });
    return serverId;
}

describe('SessionPublicLinkSection deferred approval', () => {
    beforeEach(async () => {
        await harness.reset();
        modal.update.mockReset();
        modal.hide.mockReset();
        modal.alert.mockReset();
    });

    afterEach(() => standardCleanup());

    it('renders an approval-routed publication as pending and settles it through the executed approval', async () => {
        const serverId = await addPublishingHome();
        const { SessionPublicLinkSection, useSessionCollaborationPublicLink } = await import('./SessionPublicLinkSection');
        function PublicLink() {
            const link = useSessionCollaborationPublicLink({
                scope: { serverId, accountId: ACCOUNT_ID },
                sessionId: SESSION_ID,
                session: session(),
                availability: hostedAvailability(),
            });
            return <SessionPublicLinkSection link={link} hasSession shareable />;
        }
        const screen = await renderScreen(<PublicLink />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-public-link-status')?.props.children).toBe('Off'));
        await screen.pressByTestIdAsync('session-public-link-create');

        // Not an error and not a committed link: the change waits on its approval.
        await screen.pressByTestIdAsync('session-public-link-options-create');
        expect(modal.alert).not.toHaveBeenCalled();
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-public-link-approval')).not.toBeNull());
        expect(screen.findByTestId('session-public-link-status')?.props.children).toBe('Off');
        const rows = harness.artifacts(serverId).list();
        expect(rows).toHaveLength(1);
        const pending = JSON.parse(harness.artifacts(serverId).readPlainBody(rows[0]!.id)!) as Record<string, unknown>;
        expect(pending).toMatchObject({
            status: 'open',
            actionId: 'session.public_link.create',
            actionArgs: { sessionId: SESSION_ID, isConsentRequired: true },
        });
        // Nothing was published before the decision.
        expect(harness.requestsFor(PUBLIC_SHARE_CREATE_PATH).filter((request) => request.input !== null)).toHaveLength(0);

        // The Inbox approves: its replay mints and publishes the link once, and
        // the Home's authoritative read now reports it.
        const committed = {
            id: 'p-approved', expiresAt: null, useCount: 0, maxUses: null,
            isConsentRequired: true, updatedAt: 3, keyDerivation: 'fragment_v1',
        };
        // The canonical stored-content create transport publishes independent
        // lookup material; the Session read remains its subject projection.
        harness.answer(serverId, `POST ${PUBLIC_SHARE_CREATE_PATH}`, {
            body: { publicShare: committed, isolatedOrigin: 'https://public-viewer.example.test' },
        });
        harness.answer(serverId, `GET ${PUBLIC_SHARE_PATH}`, { body: { publicShare: committed } });
        const decided = await decideApprovalAsInbox(serverId, rows[0]!.id, 'approve');
        expect(decided, JSON.stringify({
            stored: harness.artifacts(serverId).readPlainBody(rows[0]!.id),
            requests: harness.requests.map((request) => request.path),
        })).toMatchObject({ ok: true, result: { status: 'executed' } });

        await waitForHomeGovernance(() => expect(screen.findByTestId('session-public-link-approval')).toBeNull());
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-public-link-status')?.props.children)
            .toBe('On'));
        // Settlement read the authoritative publication; nothing was submitted twice.
        const publications = harness.requestsFor(PUBLIC_SHARE_CREATE_PATH).filter((request) => request.input !== null);
        expect(publications).toHaveLength(1);
        expect(publications[0]?.input).toMatchObject({
            subject: { kind: 'session', id: SESSION_ID },
            isConsentRequired: true, lookupId: expect.any(String), keyDerivation: 'fragment_v1',
        });
        expect(publications[0]?.input).not.toHaveProperty('token');
        // The approval caller receives the complete link. This sheet only
        // reloads the settings projection and cannot reconstruct its secret.
        expect(screen.findByTestId('session-public-link-url')).toBeNull();
        expect(screen.findByTestId('session-public-link-hidden')).not.toBeNull();
        const settled = JSON.parse(harness.artifacts(serverId).readPlainBody(rows[0]!.id)!) as Readonly<{
            execution?: Readonly<{ result?: unknown }>;
        }>;
        const approvedPublication = SessionPublicLinkCreateActionResultV1Schema.parse(settled.execution?.result);
        const approvedUrl = new URL(approvedPublication.url);
        const secret = new URLSearchParams(approvedUrl.hash.slice(1)).get('k');
        expect(secret).toBeTruthy();
        expect(JSON.stringify(publications[0]?.input)).not.toContain(secret);
    });
});
