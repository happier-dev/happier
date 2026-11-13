import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1,
    SessionOwnerMetadataV1Schema} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import {
    SessionPublicLinkCreateActionResultV1Schema} from '@happier-dev/protocol/sessions/access/sessionAccessActionsV1';
import {
    tryWriteServerEnabledBitInPlace,
} from '@happier-dev/protocol/features/serverEnabledBit';

// Imported from their owning testkit modules, never the `@/dev/testkit` barrel:
// the harness installs its network boundaries with `vi.doMock`, which only
// reaches modules imported afterwards (see `installHomeGovernanceBoundaries`).
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createUiApprovalRequest } from '@/dev/testkit/harness/approvalInbox';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
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

const modal = vi.hoisted(() => ({ update: vi.fn(), hide: vi.fn(), alert: vi.fn(), confirm: vi.fn(async () => true), show: vi.fn((_config: unknown) => 'network-confirmation') }));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: modal }).module;
});

const harness = createHomeGovernanceHarness();
const httpBoundary = { ...harness, request: createSessionReadBatchFetchBoundary(harness.request) };
installHomeGovernanceBoundaries(httpBoundary);
// Load the real approval owner after installing only its transport/platform boundaries.
const { useApprovalDecisionHandler } = await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');

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
    harness.answer(serverId, `/v1/sessions/${SESSION_ID}/messages?scope=main&projection=externalShareableV1`, {
        body: { messages: [], hasMore: false, nextBeforeSeq: null },
    });
    return serverId;
}

/** Real published tool correspondence and Session record; only Home HTTP responses are replaced. */
function answerPublicVisual(serverId: string, network: 'none' | 'open') {
    const revision = network === 'none' ? 'ssr1.AAAACHN5c3JlY18xAAAAAQ' : 'ssr1.AAAACHN5c3JlY18xAAAAAg';
    const acknowledgedRevision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
    const item = { v: 1, destination: 'transcript', title: 'HTML', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'hostedHtml', source: { v: 1, entrypoint: 'index.html', files: {
            'index.html': { mime: 'text/html', contentBase64: 'PGgxPkhlbGxvPC9oMT4=' },
        } }, requestedCapabilities: { network } } };
    const rawCall = { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'call', id: 'call',
        name: 'session_board_item_upsert', input: { sessionId: SESSION_ID, itemId: 'visual', expectedItemRevision: null,
            destination: 'transcript', item } } } };
    const rawResult = { role: 'agent', content: { type: 'codex', data: { type: 'tool-call-result', callId: 'call', id: 'answer', isError: false,
        output: JSON.stringify({ v: 1, serverId, sessionId: SESSION_ID, destination: null, itemDestination: 'transcript',
            result: { operation: 'upsert_item', itemId: 'visual', outcome: 'created', itemRevision: acknowledgedRevision } }) } } };
    harness.answer(serverId, `/v1/sessions/${SESSION_ID}/messages?scope=main&projection=externalShareableV1`, {
        body: { messages: [
            { id: 'call-message', seq: 1, localId: null, createdAt: 1, surfaceItemReference: null, content: { t: 'plain', v: rawCall } },
            { id: 'answer-message', seq: 2, localId: null, createdAt: 1, content: { t: 'plain', v: rawResult },
                surfaceItemReference: { v: 1, references: [{ v: 1, itemId: 'visual', itemRevision: acknowledgedRevision,
                    sourceAddress: { serverId, sessionId: SESSION_ID } }] } },
        ], hasMore: false, nextBeforeSeq: null },
    });
    harness.answer(serverId, `/v2/sessions/${SESSION_ID}/system-records/record?owner=host&namespace=surface&kind=item.v1&localId=visual`, {
        body: { record: { id: 'row', revision, address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' },
            content: { t: 'plain', v: item }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' } },
    });
}

describe('SessionPublicLinkSection deferred approval', () => {
    beforeEach(async () => {
        await harness.reset();
        installHomeGovernanceBoundaries(httpBoundary);
        modal.update.mockReset();
        modal.hide.mockReset();
        modal.alert.mockReset();
        modal.confirm.mockReset().mockResolvedValue(true);
        modal.show.mockClear();
    });

    afterEach(() => standardCleanup());

    it.each(['default', 'ask'] as const)('uses the canonical %s policy when turning off a public link', async policy => {
        const serverId = await addPublishingHome();
        if (policy === 'ask') await harness.requireUiApproval(serverId, 'session.public_link.remove');
        const active = { id: 'active-link', expiresAt: null, useCount: 0, maxUses: null, isConsentRequired: true, updatedAt: 1 };
        let removed = false;
        harness.answer(serverId, `GET ${PUBLIC_SHARE_PATH}`, { select: () => ({ body: { publicShare: removed ? null : active } }) });
        harness.answer(serverId, `DELETE ${PUBLIC_SHARE_PATH}`, { select: () => { removed = true; return { body: { success: true } }; } });
        const { SessionPublicLinkSection, useSessionCollaborationPublicLink } = await import('./SessionPublicLinkSection');
        function PublicLink() {
            const link = useSessionCollaborationPublicLink({ scope: { serverId, accountId: ACCOUNT_ID },
                sessionId: SESSION_ID, session: session(), availability: hostedAvailability() });
            return <SessionPublicLinkSection link={link} hasSession shareable />;
        }
        const screen = await renderScreen(<PublicLink />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-public-link-status')?.props.children).toBe('On'));
        await screen.pressByTestIdAsync('session-public-link-turn-off');
        if (policy === 'ask') {
            await waitForHomeGovernance(() => expect(screen.findByTestId('session-public-link-approval')).not.toBeNull());
            const rows = harness.artifacts(serverId).list();
            expect(rows).toHaveLength(1);
            expect(JSON.parse(harness.artifacts(serverId).readPlainBody(rows[0]!.id)!)).toMatchObject({
                status: 'open', actionId: 'session.public_link.remove', actionArgs: { sessionId: SESSION_ID },
            });
            expect(removed).toBe(false);
            expect(modal.confirm).not.toHaveBeenCalled();
        } else {
            await waitForHomeGovernance(() => expect(screen.findByTestId('session-public-link-status')?.props.children).toBe('Off'));
            expect(removed).toBe(true);
            expect(modal.confirm).toHaveBeenCalledTimes(1);
            expect(harness.artifacts(serverId).list()).toHaveLength(0);
        }
    });

    it('keeps a declined public-link removal at the policy owner silent and unchanged', async () => {
        const serverId = await addPublishingHome();
        harness.answer(serverId, `GET ${PUBLIC_SHARE_PATH}`, { body: { publicShare: {
            id: 'active-link', expiresAt: null, useCount: 0, maxUses: null, isConsentRequired: true, updatedAt: 1,
        } } });
        modal.confirm.mockResolvedValue(false);
        const { SessionPublicLinkSection, useSessionCollaborationPublicLink } = await import('./SessionPublicLinkSection');
        let remove: (() => Promise<void>) | undefined;
        function PublicLink() {
            const link = useSessionCollaborationPublicLink({ scope: { serverId, accountId: ACCOUNT_ID },
                sessionId: SESSION_ID, session: session(), availability: hostedAvailability() });
            remove = link.remove;
            return <SessionPublicLinkSection link={link} hasSession shareable />;
        }
        const screen = await renderScreen(<PublicLink />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-public-link-status')?.props.children).toBe('On'));
        await act(async () => { await expect(remove!()).resolves.toBeUndefined(); });
        expect(modal.confirm).toHaveBeenCalledTimes(1);
        expect(harness.requestsFor(PUBLIC_SHARE_PATH)).toHaveLength(1);
        expect(screen.findByTestId('session-public-link-status')?.props.children).toBe('On');
        expect(screen.findByTestId('session-public-link-mutation-error')).toBeNull();
        expect(modal.alert).not.toHaveBeenCalled();
    });

    it('rereads a public Session visual changed while the Share confirmation is open and requires a fresh confirmation', async () => {
        const serverId = await addPublishingHome();
        answerPublicVisual(serverId, 'none');
        const { SessionPublicLinkSection, useSessionCollaborationPublicLink } = await import('./SessionPublicLinkSection');
        let controller: ReturnType<typeof useSessionCollaborationPublicLink> | undefined;
        function PublicLink() {
            const link = useSessionCollaborationPublicLink({ scope: { serverId, accountId: ACCOUNT_ID },
                sessionId: SESSION_ID, session: session(), availability: hostedAvailability() });
            controller = link;
            return <SessionPublicLinkSection link={link} hasSession shareable />;
        }
        const screen = await renderScreen(<PublicLink />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-public-link-status')?.props.children).toBe('Off'));
        await screen.pressByTestIdAsync('session-public-link-create');
        await act(async () => {
            expect(await controller!.prepareNetworkConsequence(), JSON.stringify(harness.requests.map(request => request.path)))
                .toMatchObject({ status: 'ready', visualCount: 1, networkVisualCount: 0 });
        });
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('0 of 1'));
        answerPublicVisual(serverId, 'open');
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-public-link-mutation-error')
            ?? screen.findByTestId('session-public-link-approval')).not.toBeNull());
        expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull();
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        expect(harness.requestsFor(PUBLIC_SHARE_CREATE_PATH)).toHaveLength(0);
        expect(screen.getTextContent()).toContain('1 of 1');
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
    });

    it('generic Session approval refuses a visual policy widened while its final confirmation is open', async () => {
        const serverId = await addPublishingHome();
        answerPublicVisual(serverId, 'none');
        const artifactId = await createUiApprovalRequest({ serverId, actionId: 'session.public_link.create',
            actionInput: { sessionId: SESSION_ID, isConsentRequired: true }, actionRequestId: 'stale-share-network' });
        const { ApprovalRequestV2Schema} = await import('@happier-dev/protocol/approvals/approvalRequestV1');
        const approval = ApprovalRequestV2Schema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId)!));
        let decide: ReturnType<typeof useApprovalDecisionHandler> | undefined;
        function GenericApproval() {
            decide = useApprovalDecisionHandler({ id: artifactId, header: null }, approval, SESSION_ID, serverId);
            return null;
        }
        await renderScreen(<GenericApproval />);
        let decision: Promise<boolean> | undefined;
        await act(async () => { decision = decide!('approve'); void decision.catch(() => {}); });
        await waitForHomeGovernance(() => expect(modal.show).toHaveBeenCalledTimes(1));
        const confirmation = modal.show.mock.lastCall![0] as unknown as {
            component: React.ComponentType<{ onClose: () => void }>; props: Record<string, unknown>;
        };
        const Confirmation = confirmation.component;
        const screen = await renderScreen(<Confirmation {...confirmation.props} onClose={() => {}} />);
        expect(screen.getTextContent(), JSON.stringify(harness.requests.map(request => request.path))).toContain('0 of 1');
        answerPublicVisual(serverId, 'open');
        await screen.pressByTestIdAsync('public-link-network-confirm');
        await expect(decision).rejects.toMatchObject({ code: 'approval_stale' });
        expect(harness.requestsFor(PUBLIC_SHARE_CREATE_PATH)).toHaveLength(0);
        expect(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId)!)).toMatchObject({ status: 'open' });
    });

    it('generic approval confirms the actual network consequence and narrows off before its one original replay', async () => {
        const serverId = await addPublishingHome();
        harness.answer(serverId, `POST ${PUBLIC_SHARE_CREATE_PATH}`, { body: { publicShare: {
            id: 'generic-approved', expiresAt: null, useCount: 0, maxUses: null,
            isConsentRequired: true, updatedAt: 3, keyDerivation: 'fragment_v1', networkOff: true,
        }, viewerOrigin: 'https://public-viewer.example.test' } });
        const artifactId = await createUiApprovalRequest({ serverId, actionId: 'session.public_link.create',
            actionInput: { sessionId: SESSION_ID, isConsentRequired: true }, actionRequestId: 'generic-share-network' });
        const { ApprovalRequestV2Schema} = await import('@happier-dev/protocol/approvals/approvalRequestV1');
        const approval = ApprovalRequestV2Schema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId)!));
        let decide: ReturnType<typeof useApprovalDecisionHandler> | undefined;
        function GenericApproval() {
            decide = useApprovalDecisionHandler({ id: artifactId, header: null },
                approval, SESSION_ID, serverId);
            return null;
        }
        await renderScreen(<GenericApproval />);
        let decision: Promise<boolean> | undefined;
        let settled = false;
        await act(async () => { decision = decide!('approve'); void decision.finally(() => { settled = true; }); });
        await waitForHomeGovernance(() => expect(modal.show.mock.calls.length > 0 || settled).toBe(true));
        expect(harness.requestsFor(PUBLIC_SHARE_CREATE_PATH)).toHaveLength(0);
        expect(modal.show).toHaveBeenCalledTimes(1);
        const confirmation = modal.show.mock.calls[0]![0] as unknown as {
            component: React.ComponentType<{ onClose: () => void }>; props: Record<string, unknown>;
        };
        const Confirmation = confirmation.component;
        const screen = await renderScreen(<Confirmation {...confirmation.props} onClose={() => {}} />);
        await act(async () => { screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
        await screen.pressByTestIdAsync('public-link-network-confirm');
        await waitForHomeGovernance(() => expect(harness.requestsFor(PUBLIC_SHARE_CREATE_PATH)).toHaveLength(1));
        expect(harness.requestsFor(PUBLIC_SHARE_CREATE_PATH)[0]!.input).toMatchObject({ networkOff: true });
        await expect(decision).resolves.toBe(true);
        expect(harness.artifacts(serverId).list()).toHaveLength(1);
        expect(harness.requestsFor(PUBLIC_SHARE_CREATE_PATH)).toHaveLength(1);
        expect(modal.confirm).not.toHaveBeenCalled();
        expect(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId)!)).toMatchObject({
            status: 'executed', decision: { narrowedInput: { sessionId: SESSION_ID, isConsentRequired: true, networkOff: true } },
        });
    });

    it('keeps an original approval open when its incomplete consequence cannot be confirmed and its owner closes', async () => {
        const serverId = await addPublishingHome();
        harness.answer(serverId, `/v1/sessions/${SESSION_ID}/messages?scope=main&projection=externalShareableV1`, {
            body: { messages: [] },
        });
        const artifactId = await createUiApprovalRequest({ serverId, actionId: 'session.public_link.create',
            actionInput: { sessionId: SESSION_ID, isConsentRequired: true }, actionRequestId: 'generic-share-incomplete' });
        const { ApprovalRequestV2Schema} = await import('@happier-dev/protocol/approvals/approvalRequestV1');
        const approval = ApprovalRequestV2Schema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId)!));
        let decide: ReturnType<typeof useApprovalDecisionHandler> | undefined;
        function GenericApproval() {
            decide = useApprovalDecisionHandler({ id: artifactId, header: null }, approval, SESSION_ID, serverId);
            return null;
        }
        const owner = await renderScreen(<GenericApproval />);
        let decision: Promise<boolean> | undefined;
        await act(async () => { decision = decide!('approve'); });
        await waitForHomeGovernance(() => expect(modal.show).toHaveBeenCalledTimes(1));
        const confirmation = modal.show.mock.calls[0]![0] as unknown as {
            component: React.ComponentType<{ onClose: () => void }>; props: Record<string, unknown>;
        };
        expect(confirmation.props).toMatchObject({ available: false, initiallyOff: false });
        const Confirmation = confirmation.component;
        const screen = await renderScreen(<Confirmation {...confirmation.props} onClose={() => {}} />);
        expect(screen.findHostByTestId('public-link-network-confirm')?.props.accessibilityState).toMatchObject({ disabled: true });
        await screen.pressByTestIdAsync('public-link-network-confirm');
        expect(harness.requestsFor(PUBLIC_SHARE_CREATE_PATH)).toHaveLength(0);
        await act(async () => { owner.unmount(); });
        await expect(decision).resolves.toBe(true);
        expect(modal.hide).toHaveBeenCalledWith('network-confirmation');
        expect(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId)!)).toMatchObject({ status: 'open' });
        expect(harness.requestsFor(PUBLIC_SHARE_CREATE_PATH)).toHaveLength(0);
    });

    it('withdraws an in-flight captured transcript preparation when its approval owner closes', async () => {
        const serverId = await addPublishingHome();
        const messagesPath = `/v1/sessions/${SESSION_ID}/messages?scope=main&projection=externalShareableV1`;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        harness.answer(serverId, messagesPath, { body: { messages: [], hasMore: false, nextBeforeSeq: null }, respondAfter: gate });
        const artifactId = await createUiApprovalRequest({ serverId, actionId: 'session.public_link.create',
            actionInput: { sessionId: SESSION_ID, isConsentRequired: true }, actionRequestId: 'generic-share-retired-read' });
        const { ApprovalRequestV2Schema} = await import('@happier-dev/protocol/approvals/approvalRequestV1');
        const approval = ApprovalRequestV2Schema.parse(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId)!));
        let decide: ReturnType<typeof useApprovalDecisionHandler> | undefined;
        function GenericApproval() {
            decide = useApprovalDecisionHandler({ id: artifactId, header: null }, approval, SESSION_ID, serverId);
            return null;
        }
        const owner = await renderScreen(<GenericApproval />);
        let decision: Promise<boolean> | undefined;
        await act(async () => { decision = decide!('approve'); });
        await waitForHomeGovernance(() => expect(harness.requestsFor(messagesPath)).toHaveLength(1));
        await act(async () => { owner.unmount(); release(); });
        await expect(decision).resolves.toBe(true);
        expect(modal.show).not.toHaveBeenCalled();
        expect(harness.requestsFor(PUBLIC_SHARE_CREATE_PATH)).toHaveLength(0);
        expect(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId)!)).toMatchObject({ status: 'open' });
    });

    it('checks public visuals only on explicit link preparation and refuses unknown networking unless switched off', async () => {
        const serverId = await addPublishingHome();
        const messagesPath = `/v1/sessions/${SESSION_ID}/messages?scope=main&projection=externalShareableV1`;
        // An incomplete full transcript is not proof that no included visual can contact another site.
        harness.answer(serverId, messagesPath, { body: { messages: [] } });
        const { SessionPublicLinkSection, useSessionCollaborationPublicLink } = await import('./SessionPublicLinkSection');
        function PublicLink() {
            const link = useSessionCollaborationPublicLink({ scope: { serverId, accountId: ACCOUNT_ID },
                sessionId: SESSION_ID, session: session(), availability: hostedAvailability() });
            return <SessionPublicLinkSection link={link} hasSession shareable />;
        }
        const screen = await renderScreen(<PublicLink />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('session-public-link-status')?.props.children).toBe('Off'));
        expect(harness.requestsFor(messagesPath)).toHaveLength(0);
        await screen.pressByTestIdAsync('session-public-link-create');
        await vi.waitFor(() => expect(harness.requestsFor(messagesPath)).toHaveLength(1));
        await vi.waitFor(() => expect(screen.findHostByTestId('session-public-link-options-create')?.props.accessibilityState).toMatchObject({ disabled: true }));
        expect(harness.requestsFor(PUBLIC_SHARE_CREATE_PATH)).toHaveLength(0);
        await act(async () => { screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
        await vi.waitFor(() => expect(screen.findHostByTestId('session-public-link-options-create')?.props.accessibilityState).toMatchObject({ disabled: false }));
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await waitForHomeGovernance(() => expect(harness.artifacts(serverId).list()).toHaveLength(1));
        const pending = JSON.parse(harness.artifacts(serverId).readPlainBody(harness.artifacts(serverId).list()[0]!.id)!);
        expect(pending).toMatchObject({ actionArgs: { networkOff: true } });
    });

    it('privately delivers an explicit publication approval and persists only publication settings', async () => {
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
        // A person's ordinary Create answers Ask in its native confirmation.
        // An explicit proposal uses the shared approval Action and Inbox replay.
        await createUiApprovalRequest({ serverId, actionId: 'session.public_link.create',
            actionInput: { sessionId: SESSION_ID, isConsentRequired: true },
            actionRequestId: 'private-session-publication' });
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
            body: { publicShare: committed, viewerOrigin: 'https://public-viewer.example.test' },
        });
        harness.answer(serverId, `GET ${PUBLIC_SHARE_PATH}`, { body: { publicShare: committed } });
        const { ApprovalRequestV2Schema} = await import('@happier-dev/protocol/approvals/approvalRequestV1');
        const original = ApprovalRequestV2Schema.parse(pending);
        let decide: ReturnType<typeof useApprovalDecisionHandler> | undefined;
        function Inbox() {
            decide = useApprovalDecisionHandler({ id: rows[0]!.id, header: null }, original, SESSION_ID, serverId);
            return null;
        }
        await renderScreen(<Inbox />);
        let decision: Promise<boolean> | undefined;
        await act(async () => { decision = decide!('approve'); });
        await waitForHomeGovernance(() => expect(modal.show).toHaveBeenCalledTimes(1));
        const confirmation = modal.show.mock.calls[0]![0] as unknown as {
            component: React.ComponentType<{ onClose: () => void }>; props: Record<string, unknown>;
        };
        const Confirmation = confirmation.component;
        const confirmationScreen = await renderScreen(<Confirmation {...confirmation.props} onClose={() => {}} />);
        await confirmationScreen.pressByTestIdAsync('public-link-network-confirm');
        await expect(decision).resolves.toBe(true);
        expect(JSON.parse(harness.artifacts(serverId).readPlainBody(rows[0]!.id)!)).toMatchObject({ status: 'executed' });

        const settledScreen = await renderScreen(<PublicLink />);
        await waitForHomeGovernance(() => expect(settledScreen.findByTestId('session-public-link-status')?.props.children)
            .toBe('On'));
        // Settlement read the authoritative publication; nothing was submitted twice.
        const publications = harness.requestsFor(PUBLIC_SHARE_CREATE_PATH).filter((request) => request.input !== null);
        expect(publications).toHaveLength(1);
        expect(publications[0]?.input).toMatchObject({
            subject: { kind: 'session', id: SESSION_ID },
            isConsentRequired: true, lookupId: expect.any(String), keyDerivation: 'fragment_v1',
        });
        expect(publications[0]?.input).not.toHaveProperty('token');
        // Approval replay delivers privately; a later sheet reads only
        // settings and cannot reconstruct the newly issued capability.
        expect(settledScreen.findByTestId('session-public-link-url')).toBeNull();
        expect(settledScreen.findByTestId('session-public-link-hidden')).not.toBeNull();
        const settled = JSON.parse(harness.artifacts(serverId).readPlainBody(rows[0]!.id)!) as Readonly<{
            execution?: Readonly<{ result?: unknown }>;
        }>;
        const approvedPublication = SessionPublicLinkCreateActionResultV1Schema.parse(settled.execution?.result);
        expect(approvedPublication).not.toHaveProperty('url');
        const delivered = modal.show.mock.calls.map(([config]) => config as Readonly<{
            chrome?: Readonly<{ testID?: string }>;
            props?: Readonly<{ shareUrl?: string; audience?: string }>;
        }>).filter(config => config.chrome?.testID === 'document-issued-link');
        expect(delivered).toHaveLength(1);
        expect(delivered[0]?.props?.audience).toBe('anonymous');
        const issuedUrl = delivered[0]?.props?.shareUrl;
        if (typeof issuedUrl !== 'string') throw new Error('Expected private issued-link presentation');
        const approvedUrl = new URL(issuedUrl);
        const secret = new URLSearchParams(approvedUrl.hash.slice(1)).get('k');
        expect(secret).toBeTruthy();
        expect(JSON.stringify(publications[0]?.input)).not.toContain(secret);
    });
});
// Native filesystem classes are an OS boundary, not part of this source-driven UI journey.
vi.mock('expo-file-system', async () =>
    (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);
