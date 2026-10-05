import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSessionFixture, createTestSessionTranscriptSource, renderScreen, standardCleanup, wrapWithSessionTranscriptSource } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { readNewSessionDraftProjectionFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { WorkflowsColumnActions } from '../column/WorkflowsColumnActions';
import { WorkflowsLibraryHome } from '../library/WorkflowsLibraryHome';
import type { IModal } from '@/modal';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { buildWorkflowAgentAuthoringSeed } from '@/sync/domains/workflows/workflowAgentAuthoringSeed';
import { getSessionDraftSnapshot, listNewSessionDraftProjections, resetSessionDraftRepositoryForTests, writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { createRepositoryComposerDocumentOwner } from '@/components/sessions/composer/repositoryComposerDocumentOwner';
import { useWorkflowMakeRepeatable } from './useWorkflowMakeRepeatable';
import { CommittedMessageActions } from '@/components/sessions/transcript/messageActions/CommittedMessageActions';
import { resolveSelectableMessageText } from '@/components/sessions/transcript/messageSelection/resolveSelectableMessageText';
import type { AgentTextMessage } from '@happier-dev/session-core/messages';
import { stubServerFeaturesFetch } from '@/hooks/server/serverFeaturesTestUtils';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
const show = vi.hoisted(() => vi.fn<IModal['show']>(() => 'authoring-sheet'));
const state = vi.hoisted(() => ({ populated: false, serverId: 'server-a' }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { show } }).module);
vi.mock('@/sync/domains/state/browserRecordStorage', async () => (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock());
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerSnapshot: () => ({ serverId: state.serverId }), isAppliedActiveServerRuntimeAvailable: () => true,
}));
// The Action transport is the only data boundary. Library clients and collection logic stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => async (id: string) => {
    if (id === 'workflow.definition.list') return { ok: true, result: { definitions: state.populated ? [{
        definitionId: '00000000-0000-4000-8000-000000000005', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Saved' },
    }] : [] } };
    if (id === 'workflow.run.list') return { ok: true, result: { runs: [], metadataByRunId: {} } };
    if (id === 'workflow.run.summaries') return { ok: true, result: { summaries: [] } };
    if (id === 'workflow.trigger.list') return { ok: true, result: { sets: [] } };
    return { ok: false, errorCode: 'unsupported_action', error: id };
} }));
beforeEach(async () => {
    resetSessionDraftRepositoryForTests();
    await prepareSessionDraftPersistenceStorage();
    state.serverId = 'server-a';
    show.mockClear();
    getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' }, settings: settingsDefaults });
});
afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); });

function expectSeededSheet() {
    const modal = show.mock.calls.at(-1)?.[0];
    expect(modal?.chrome?.testID).toBe('workflow-agent-authoring-sheet');
    const props = modal?.props as { draftId: string } | undefined;
    expect(props?.draftId).toBeTruthy();
    const snapshot = props ? readNewSessionDraftProjectionFromRepository({ draftId: props.draftId, scope: { serverId: 'server-a', accountId: 'account-a' } }) : null;
    expect(snapshot?.draft.input).toBe(buildWorkflowAgentAuthoringSeed({ kind: 'create' }).prompt);
    // The sheet states what happens before anything is sent (07 S22).
    expect(modal?.chrome?.subtitle).toBe('workflows.authoring.description');
}

it('the column + entry opens the seeded real-composer sheet', async () => {
    const screen = await renderScreen(<WorkflowsColumnActions canCreate />);
    const menu = screen.root.findAllByType(DropdownMenu).find((node) => node.props.testID === 'workflows-column:add:menu');
    expect(menu?.props.items.some((item: { id: string }) => item.id === 'agent')).toBe(true);
    await act(async () => menu?.props.onSelect('agent'));
    expectSeededSheet();
});

it.each([false, true])('the first-visit/home entry opens the same seeded sheet (populated=%s)', async (populated) => {
    state.populated = populated;
    const screen = await renderScreen(<WorkflowsLibraryHome />);
    await act(async () => {});
    await screen.pressByTestIdAsync(populated ? 'workflows-home:agent' : 'workflows-home:firstVisit:agent');
    expectSeededSheet();
});

it.each(['header', 'message'] as const)('the %s repeatable action prefills the current Session composer without opening a sheet or creating a Session', async (entry) => {
    const server = await upsertServerProfile({ serverUrl: 'https://repeatable.test', name: 'Repeatable test' });
    await setActiveServerId(server.id, { scope: 'device' });
    state.serverId = server.id;
    const session = createSessionFixture({ id: 'source-session', serverId: server.id });
    getStorage().setState({ profileScope: { serverId: server.id, accountId: 'account-a' }, sessions: { [session.id]: session } });
    getStorage().getState().applySettingsLocal({ experiments: true, featureToggles: { automations: true, workflows: true } });
    await stubServerFeaturesFetch({ automationsEnabled: true });
    await getServerFeaturesSnapshot({ serverId: server.id, force: true });
    const scope = { serverId: server.id, accountId: 'account-a' };
    const address = { kind: 'session' as const, sessionId: session.id };
    writeExistingSessionDraft({ scope, sessionId: session.id, patch: { text: 'Earlier unsent text' } });
    const composer = createRepositoryComposerDocumentOwner({ scope, ref: { kind: 'session', sessionId: session.id } });
    const message = { id: 'message-7', text: 'The successful audit' };
    function HeaderEntry() {
        const settings = getStorage()((current) => current.settings);
        const repeatable = useWorkflowMakeRepeatable({ sessionId: session.id, serverId: server.id,
            ...(entry === 'message' ? { message } : {}),
        });
        if (entry === 'message') {
            const committed: AgentTextMessage = { ...message, kind: 'agent-text', localId: null, createdAt: 1 };
            return <CommittedMessageActions message={committed} sessionId={session.id} serverId={server.id}
                selectableText={resolveSelectableMessageText({ message: committed, isStructuredOnly: false, hasAttachmentBlockToStrip: false })}
                copyText={message.text} isStructuredOnly={false} canFork={false} isForkAllowed={() => false}
                forkCommon={{ sessionReplayEnabled: false, sessionReplayMaxSeedChars: 0, sessionReplayStrategy: 'recent_messages',
                    sessionReplaySummaryRunnerV1: null, executionRunsEnabled: false, agentSwitchingEnabled: false,
                    sessionForkSupportSource: { metadata: null } }}
                settings={{ ...settings, workspacePath: null, debugInformationEnabled: false }} makeRepeatable={repeatable}
                showActions showPinAction={false} timestampText={null} invertTimestampAndActions={false}
                onActionsFocus={() => {}} onActionsBlur={() => {}}>{(row) => row}</CommittedMessageActions>;
        }
        return <button disabled={!repeatable.available} onClick={repeatable.openRepeatable} />;
    }
    const screen = await renderScreen(wrapWithSessionTranscriptSource(<HeaderEntry />,
        createTestSessionTranscriptSource({ sessionId: session.id, serverId: server.id })));
    if (entry === 'message') await screen.pressByTestIdAsync('transcript-message-repeatable:message-7');
    else {
        expect(screen.root.findByType('button').props.disabled).toBe(false);
        await act(async () => screen.root.findByType('button').props.onClick());
    }
    const expected = buildWorkflowAgentAuthoringSeed({ kind: 'repeatable', sessionId: session.id, serverId: server.id,
        ...(entry === 'message' ? { message } : {}),
    }).prompt;
    expect(getSessionDraftSnapshot(scope, address)?.document.composer.text.value).toBe(expected);
    expect(composer.read().document.text).toBe(expected);
    expect(show).not.toHaveBeenCalled();
    expect(listNewSessionDraftProjections(scope)).toEqual([]);
    expect(Object.keys(getStorage().getState().sessions)).toEqual([session.id]);
    if (entry === 'message') {
        await act(async () => getStorage().getState().applySettingsLocal({ transcriptMessageMakeRepeatableActionEnabled: false }));
        expect(screen.findHostByTestId('transcript-message-repeatable:message-7')).toBeNull();
    }
    // The ordinary composer remains the editable owner after prefilling.
    composer.replaceDocument({ ...composer.read().document, text: `${expected}\nMy change` });
    expect(getSessionDraftSnapshot(scope, address)?.document.composer.text.value).toBe(`${expected}\nMy change`);
});
