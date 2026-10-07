import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionFixture, renderScreen as renderBareScreen, standardCleanup } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { UserTextMessage } from "@happier-dev/session-core/messages";
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionMessageProvenance } from '@happier-dev/protocol';

installMessageViewCommonModuleMocks();
const { MessageView, MessageViewWithSessionCommon } = await import('./MessageView');
const { AppSessionTranscriptSourceProvider } = await import('./source/appSessionTranscriptSource');

// These cases prove the real Home-scoped store-to-authorship path, not snapshot bylines.
function renderScreen(element: React.ReactElement<{ sessionId: string; serverId?: string | null }>) {
    return renderBareScreen(
        <AppSessionTranscriptSourceProvider sessionId={element.props.sessionId} serverId={element.props.serverId}>
            {element}
        </AppSessionTranscriptSourceProvider>,
    );
}

afterEach(() => {
    standardCleanup();
    storage.setState(storage.getInitialState(), true);
});

describe('MessageView Account attribution', () => {
    it.each([
        [{ v: 1, kind: 'happierSession', sourceSessionId: 'session-source-a', via: 'mcp' }, 'message.provenanceFrom(source=Lead A)'],
        [{ v: 1, kind: 'pluginSession', pluginId: 'acme.preview', contributionLocalId: 'inbound', surface: 'unspecified' }, 'message.pluginAttribution(pluginId=acme.preview)'],
        [{ v: 1, kind: 'automation', automationId: 'automation-a', runId: 'run-a' }, 'message.provenanceFrom(source=message.provenanceAutomation)'],
        [{ v: 2, kind: 'workflow_invocation', runId: 'run-a', invocationRecordId: 'invocation-a' }, 'message.provenanceFrom(source=message.provenanceWorkflow)'],
    ] satisfies [SessionMessageProvenance, string][])('attributes %j to its producer', async (provenance, label) => {
        storage.setState({ sessions: {
            'session-source-a': createSessionFixture({
                id: 'session-source-a', metadata: null, metadataLayoutVersion: 1,
                ownerMetadataView: { ...createSessionFixture().metadata!, name: 'Lead A' },
            }),
        } });
        const message: UserTextMessage = {
            kind: 'user-text', id: 'producer-message', localId: null, createdAt: 1, text: 'Continue the work',
            meta: { happierProvenanceV1: provenance },
        };
        const screen = await renderScreen(
            <MessageViewWithSessionCommon
                sessionId="session-b" metadata={null} message={message}
                forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                toolChromeCommon={settingsDefaults} toolRouteCommon={{ messagesById: {}, reducerState: null }}
            />,
        );
        const testId = provenance.kind === 'pluginSession' ? 'transcript-plugin-attribution:producer-message' : 'transcript-provenance-attribution:producer-message';
        expect(screen.findHostByTestId(testId)?.props.accessibilityLabel).toBe(label);
        expect(screen.findHostByTestId('transcript-account-attribution:producer-message')).toBeNull();
    });

    it('names the sending Session only from the transcript Home', async () => {
        const homeA = await upsertServerProfile({ serverUrl: 'https://producer-home-a.example.test' });
        const homeB = await upsertServerProfile({ serverUrl: 'https://producer-home-b.example.test' });
        const sourceSession = (serverId: string, title: string) => createSessionFixture({
            id: 'same-source-id', serverId, metadataLayoutVersion: 1,
            metadata: { ...createSessionFixture().metadata!, name: title },
        });
        storage.setState({
            sessions: { 'same-source-id': sourceSession(homeA.id, 'Other Home title') },
            sessionListRowsByServerId: { [homeB.id]: { 'same-source-id': sourceSession(homeB.id, 'Lead B') } },
            sessionListIndexByServerId: { [homeB.id]: [{ type: 'session', sessionId: 'same-source-id', serverId: homeB.id }] },
        });
        const screen = await renderScreen(
            <MessageViewWithSessionCommon
                sessionId="target" serverId={homeB.id} metadata={null}
                message={{
                    kind: 'user-text', id: 'home-scoped-producer', localId: null, createdAt: 1, text: 'Continue',
                    meta: { happierProvenanceV1: { v: 1, kind: 'happierSession', sourceSessionId: 'same-source-id', via: 'mcp' } },
                }}
                forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                messageDisplayCommon={{ ...settingsDefaults, workspacePath: null, debugInformationEnabled: false }}
                toolChromeCommon={settingsDefaults} toolRouteCommon={{ messagesById: {}, reducerState: null }}
            />,
        );
        expect(screen.findHostByTestId('transcript-provenance-attribution:home-scoped-producer')?.props.accessibilityLabel)
            .toBe('message.provenanceFrom(source=Lead B)');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('Other Home title');
    });

    it('renders a single trusted human byline before the bubble while preserving recovered-history status', async () => {
        const message: UserTextMessage = {
            kind: 'user-text', id: 'actor-message', localId: null, createdAt: 1, text: 'Review the migration',
            accountActor: {
                v: 1, serverId: 'home-a', accountId: 'private-account-id',
                profile: { firstName: 'Alice', lastName: 'Chen', username: null, avatarUrl: null },
            },
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
            meta: {
                happierProvenanceV1: { v: 1, kind: 'pluginSession', pluginId: 'acme.preview', contributionLocalId: 'inbound', surface: 'unspecified' },
            },
        };
        const screen = await renderScreen(
            <MessageViewWithSessionCommon
                sessionId="session-a"
                metadata={null}
                message={message}
                forkCommon={{ ...settingsDefaults, executionRunsEnabled: false, agentSwitchingEnabled: false, sessionForkSupportSource: null }}
                messageDisplayCommon={{
                    ...settingsDefaults, workspacePath: null, debugInformationEnabled: false,
                    accountActorViewerScope: { serverId: 'home-a', accountId: 'viewer' },
                    hasOtherNamedCollaborator: true,
                }}
                toolChromeCommon={settingsDefaults}
                toolRouteCommon={{ messagesById: {}, reducerState: null }}
            />,
        );
        expect(screen.findHostByTestId('transcript-account-attribution:actor-message')?.props.accessibilityLabel)
            .toBe('message.accountActorSentBy(name=Alice Chen)');
        expect(screen.findHostByTestId('transcript-recovered-history:actor-message')).not.toBeNull();
        // Revision-13 coexistence: the descriptive plugin source line and the
        // authenticated Account byline are independent siblings. Either may be
        // absent, but the presence of one must never suppress the other.
        expect(screen.findHostByTestId('transcript-plugin-attribution:actor-message')?.props.accessibilityLabel)
            .toBe('message.pluginAttribution(pluginId=acme.preview)');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('private-account-id');
    });

    /**
     * Revision-13 last mile: the mounted self byline is the thin presentation
     * projection of the server's one safe audience-existence signal on the
     * Session record. It is evaluated once per Session, never per message, and
     * is independent of live presence. The standalone `MessageView` is mounted
     * so the real session-record -> hook -> attribution chain runs.
     */
    describe('self byline audience signal (session record -> mounted transcript)', () => {
        async function seedSessionWithAudienceSignal(overrides: Partial<Session>) {
            const home = await upsertServerProfile({ serverUrl: 'https://attribution-audience.example.test' });
            storage.setState({
                profileScope: { serverId: home.id, accountId: 'viewer-a' },
                sessions: {
                    transcript: createSessionFixture({ id: 'transcript', serverId: home.id, ...overrides }),
                },
                sessionListRowsByServerId: { [home.id]: {} },
                sessionListIndexByServerId: { [home.id]: [] },
            });
            return home;
        }

        function authoredMessage(homeId: string, messageId: string, actor: { accountId: string; firstName: string }): UserTextMessage {
            return {
                kind: 'user-text', id: messageId, localId: null, createdAt: 1, text: 'Checking the migration path',
                accountActor: {
                    v: 1, serverId: homeId, accountId: actor.accountId,
                    profile: { firstName: actor.firstName, lastName: null, username: null, avatarUrl: null },
                },
            };
        }

        it('announces the mounted self byline when another collaborator is currently authorized', async () => {
            const home = await seedSessionWithAudienceSignal({ hasOtherNamedCollaborator: true });
            const screen = await renderScreen(
                <MessageView
                    sessionId="transcript"
                    metadata={null}
                    message={authoredMessage(home.id, 'self-shared', { accountId: 'viewer-a', firstName: 'Viewer' })}
                />,
            );
            expect(screen.findHostByTestId('transcript-account-attribution:self-shared')?.props.accessibilityLabel)
                .toBe('message.accountActorSentBy(name=message.accountActorYou)');
        });

        it('keeps a solo transcript quiet even when the viewer authored the message', async () => {
            const home = await seedSessionWithAudienceSignal({ hasOtherNamedCollaborator: false });
            const screen = await renderScreen(
                <MessageView
                    sessionId="transcript"
                    metadata={null}
                    message={authoredMessage(home.id, 'self-solo', { accountId: 'viewer-a', firstName: 'Viewer' })}
                />,
            );
            expect(screen.findHostByTestId('transcript-account-attribution:self-solo')).toBeNull();
        });

        it('always names another Account, independent of the audience signal', async () => {
            const home = await seedSessionWithAudienceSignal({ hasOtherNamedCollaborator: false });
            const screen = await renderScreen(
                <MessageView
                    sessionId="transcript"
                    metadata={null}
                    message={authoredMessage(home.id, 'other-solo', { accountId: 'account-alice', firstName: 'Alice' })}
                />,
            );
            expect(screen.findHostByTestId('transcript-account-attribution:other-solo')?.props.accessibilityLabel)
                .toBe('message.accountActorSentBy(name=Alice)');
        });

        it('uses the exact Home audience signal when raw Session ids collide', async () => {
            const homeA = await upsertServerProfile({ serverUrl: 'https://attribution-home-a.example.test' });
            const homeB = await upsertServerProfile({ serverUrl: 'https://attribution-home-b.example.test' });
            storage.setState({
                profileScope: { serverId: homeB.id, accountId: 'viewer-b' },
                sessions: {
                    transcript: createSessionFixture({
                        id: 'transcript',
                        serverId: homeA.id,
                        hasOtherNamedCollaborator: false,
                    }),
                },
                sessionListRowsByServerId: {
                    [homeA.id]: {
                        transcript: createSessionFixture({
                            id: 'transcript',
                            serverId: homeA.id,
                            hasOtherNamedCollaborator: false,
                        }),
                    },
                    [homeB.id]: {
                        transcript: createSessionFixture({
                            id: 'transcript',
                            serverId: homeB.id,
                            hasOtherNamedCollaborator: true,
                        }),
                    },
                },
                sessionListIndexByServerId: {
                    [homeA.id]: [{ type: 'session', sessionId: 'transcript', serverId: homeA.id }],
                    [homeB.id]: [{ type: 'session', sessionId: 'transcript', serverId: homeB.id }],
                },
            });

            const screen = await renderScreen(
                <MessageView
                    sessionId="transcript"
                    serverId={homeB.id}
                    metadata={null}
                    message={authoredMessage(homeB.id, 'self-home-b', { accountId: 'viewer-b', firstName: 'Viewer' })}
                />,
            );

            expect(screen.findHostByTestId('transcript-account-attribution:self-home-b')?.props.accessibilityLabel)
                .toBe('message.accountActorSentBy(name=message.accountActorYou)');
        });
    });
});
