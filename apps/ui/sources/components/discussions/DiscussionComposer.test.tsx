import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { changeTextTestInstance, createDeferred, createSessionFixture, renderScreen } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { t } from '@/text';
import { Modal } from '@/modal';
import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import { AgentInput } from '@/components/sessions/agentInput';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';
import type { ComposerStructuredInputMention } from '@/components/sessions/agentInput/structuredInputMentions';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { SessionHumanPresenceVisibleReplaceV1Schema } from '@happier-dev/protocol/sessions';
import { attachSessionHumanPresenceSocket, registerDiscussionHumanPresence } from '@/sync/domains/session/humanPresence/sessionHumanPresenceRuntime';
import { readDiscussionMentionedParticipantIdsV1 } from '@happier-dev/protocol/discussions/content';
import { PluginUiJsonValueV1Schema, type PluginUiHostApiRequestEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';
import { buildMentionRefForKindV1, MENTION_KIND_V1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { createComposerPresentationHostHandlers, createComposerPresentationTransactionApplier } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { ComposerReadResultV1Schema, ComposerTransactionResultV1Schema, ComposerFocusResultV1Schema } from '@happier-dev/protocol/plugins/ui/composer';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { applyDiscussionParticipantReference, createDiscussionParticipantQuestion, postDiscussionComposerContent } from '../../../../../packages/tests/fixtures/plugin-platform/composer-external-dogfood/src/discussionComposer.mjs';
import { DiscussionPostInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DISCUSSION_MODEL_SLOT_MENTION_KIND } from './discussionComposerDocument';

import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';

import { DiscussionComposer, type DiscussionComposerValue } from '@/components/discussions/DiscussionComposer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The discussion composer is the one composer (`AgentInput`) hosting the human-discussion adapter:
 * Account mentions, typing presence and editability stay here, the shell is the composer's.
 * The real `AgentInput` renders here: typing, the suggestion picker, selection and Send run through
 * it. The page supplies its admitted roster; only typing presence and platform boundaries are replaced.
 */

type CapturedAgentInputProps = Readonly<{
    value: string;
    placeholder: string;
    inputAccessibilityLabel?: string;
    disabled?: boolean;
    autocompleteKinds: readonly string[];
    autocompleteSuggestions: (query: string, signal: AbortSignal) => Promise<AutocompleteSuggestion[]>;
    structuredInputMentions?: readonly ComposerStructuredInputMention[];
    onStructuredInputMentionsChange?: (mentions: readonly ComposerStructuredInputMention[]) => void;
    onChangeText: (text: string) => void;
    onComposerFocusChange?: (focused: boolean) => void;
    onSend?: (options?: Readonly<{ inputTextOverride?: string }>) => void;
    engineControls?: string;
    voiceAffordance?: string;
    messageHistory?: string;
    extraActionChips?: readonly Readonly<{ key: string }>[];
    sessionId?: string;
    onAttachmentsAdded?: (files: readonly File[], options?: Readonly<{ sources?: readonly unknown[] }>) => unknown;
    hasSendableAttachments?: boolean;
    attachmentRowItems?: readonly Readonly<{ key: string; label?: string }>[];
}>;

installAgentInputCommonModuleMocks();
// Register these before this suite's static UI imports reach the presentation boundaries.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-image', () => ({ Image: (props: Record<string, unknown>) => React.createElement('Image', props, null) }));

const mounted = vi.hoisted(() => ({ screen: null as null | { root: { findByType: (type: unknown) => { props: Record<string, unknown> } } } }));
const accountLifetime: ServerAccountScopeLifetime = {
    scope: { serverId: 'server-b', accountId: 'viewer-b' },
    isCurrent: () => true,
    onRetire: () => ({ dispose: () => undefined }),
};
const ALICE = {
    accountId: 'account-alice',
    profile: { name: 'Alice Ng', firstName: 'Alice', lastName: 'Ng', username: 'alice', avatarUrl: null },
    accessHint: 'view' as const,
};
type ParticipantRoster = ReturnType<typeof DiscussionParticipantsListResponseV1Schema.parse>;
function defaultRoster(): ParticipantRoster {
    return DiscussionParticipantsListResponseV1Schema.parse({
        discussionId: 'discussion-1', ownerAccountId: ALICE.accountId, access: 'edit',
        grants: [{ principal: { kind: 'account', accountId: ALICE.accountId }, accessLevel: 'edit', createdByAccountId: ALICE.accountId,
            createdAt: 0, display: { name: ALICE.profile.name, username: ALICE.profile.username } }],
        accountActors: [{ v: 1, accountId: ALICE.accountId, accessibility: 'current', profile: ALICE.profile }], participants: [],
    });
}
let participantRoster: ParticipantRoster | null = defaultRoster();

/** The props the real composer was given (for adapter facts the shell doesn't print). */
function composer(): CapturedAgentInputProps {
    expect(mounted.screen).not.toBeNull();
    return mounted.screen!.root.findByType(AgentInput).props as unknown as CapturedAgentInputProps;
}

async function render(element: React.ReactElement) {
    const screen = await renderScreen(element);
    mounted.screen = screen as never;
    return screen;
}

/** The text field itself (the deepest node carrying the composer's input id), as typing reaches it. */
function composerInput(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const input = screen.root.findAll((node) => node.props.testID === 'new-session-composer-input'
        && (typeof node.props.onChangeText === 'function' || typeof node.props.onComposerChange === 'function')).at(-1);
    expect(input).toBeDefined();
    return input!;
}

async function settle() {
    await act(async () => {
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

function Harness(props: Readonly<{
    initial?: DiscussionComposerValue;
    lifetime?: ServerAccountScopeLifetime;
    disabled?: boolean;
    onSend?: (content: unknown) => void;
    onValue?: (value: DiscussionComposerValue) => void;
    roster?: ParticipantRoster | null;
    onRefreshParticipants?: () => Promise<ParticipantRoster | null>;
}>): React.ReactElement {
    const [value, setValue] = React.useState<DiscussionComposerValue>(props.initial ?? { text: '', mentions: [] });
    const [refreshed, setRefreshed] = React.useState<ParticipantRoster | null | undefined>();
    const refreshParticipants = React.useCallback(async () => {
        if (props.onRefreshParticipants) setRefreshed(await props.onRefreshParticipants());
    }, [props.onRefreshParticipants]);
    return (
        <DiscussionComposer draftAddress={{ kind: 'discussion', discussionId: 'draft-address' }}
            scope={accountLifetime.scope}
            accountLifetime={props.lifetime ?? accountLifetime}
            address={{ serverId: 'server-b' }}
            discussionId="discussion-1"
            roster={props.roster === undefined ? (refreshed === undefined ? participantRoster : refreshed) : props.roster}
            onRefreshParticipants={refreshParticipants}
            availability="available"
            value={value}
            onChange={(next) => {
                props.onValue?.(next);
                setValue(next);
            }}
            disabled={props.disabled === true}
            onSend={(content) => props.onSend?.(content)}
        />
    );
}

describe('DiscussionComposer (the one composer with the discussion adapter)', () => {
    beforeEach(() => {
        mounted.screen = null;
        participantRoster = defaultRoster();
        vi.mocked(Modal.confirm).mockReset().mockResolvedValue(false);
    });

    it('keeps an unresolved @ ask until the person explicitly sends it as text', async () => {
        const confirm = vi.mocked(Modal.confirm).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const onSend = vi.fn();
        const screen = await render(<Harness initial={{ text: '@DOCS-JOURNEY3 please review this passage', mentions: [] }} onSend={onSend} />);
        await screen.pressByTestIdAsync('new-session-composer-send');
        expect(confirm).toHaveBeenCalled();
        expect(onSend).not.toHaveBeenCalled();
        expect(composer().value).toBe('@DOCS-JOURNEY3 please review this passage');
        await screen.pressByTestIdAsync('new-session-composer-send');
        expect(onSend).toHaveBeenCalledWith({ v: 1, parts: [{ t: 'text', text: '@DOCS-JOURNEY3 please review this passage' }] });
    });

    it.each(['Email reviewer@example.com', 'Write \\@decorator literally'])('sends literal text without an addressing confirmation: %s', async text => {
        const confirm = vi.mocked(Modal.confirm);
        confirm.mockClear();
        const onSend = vi.fn();
        const screen = await render(<Harness initial={{ text, mentions: [] }} onSend={onSend} />);
        await screen.pressByTestIdAsync('new-session-composer-send');
        expect(confirm).not.toHaveBeenCalled();
        expect(onSend).toHaveBeenCalledWith({ v: 1, parts: [{ t: 'text', text }] });
    });

    it('keeps a revised draft when an earlier unresolved-mention confirmation is accepted', async () => {
        const decision = createDeferred<boolean>();
        vi.mocked(Modal.confirm).mockReturnValueOnce(decision.promise);
        const onSend = vi.fn();
        const screen = await render(<Harness initial={{ text: '@missing review this', mentions: [] }} onSend={onSend} />);
        await act(async () => { composer().onSend?.(); });
        expect(Modal.confirm).toHaveBeenCalled();
        await act(async () => { changeTextTestInstance(composerInput(screen), 'A revised question'); });
        await act(async () => { decision.resolve(true); });
        expect(onSend).not.toHaveBeenCalled();
        expect(composer().value).toBe('A revised question');
        await screen.pressByTestIdAsync('new-session-composer-send');
        expect(onSend).toHaveBeenCalledWith({ v: 1, parts: [{ t: 'text', text: 'A revised question' }] });
    });

    it('filters the admitted page roster after ordinary edits and repeated demanded queries', async () => {
        const screen = await render(<Harness />);
        try {
            await act(async () => { composerInput(screen).props.onComposerFocus?.(); });
            for (let index = 0; index < 25; index += 1) {
                await act(async () => { changeTextTestInstance(composerInput(screen), `Please review this change ${index}`); });
            }
            await settle();
            for (const query of ['@al', '@ali', '@alice']) {
                expect((await composer().autocompleteSuggestions(query, new AbortController().signal)).map(row => row.label)).toEqual(['Alice Ng']);
            }
            await act(async () => { composerInput(screen).props.onComposerBlur?.(); });
            await settle();
        } finally { await screen.unmount(); }
    });

    it('labels a former Account suggestion from its explicit relationship fact, never its retained profile', async () => {
        const roster = { ...defaultRoster(), accountActors: [{ v: 1 as const, accountId: ALICE.accountId,
            accessibility: 'former' as const, profile: ALICE.profile }] } as ParticipantRoster & {
                accountActors: readonly [{ v: 1; accountId: string; accessibility: 'former'; profile: typeof ALICE.profile }];
            };
        await render(<Harness roster={roster} />);

        const rows = await composer().autocompleteSuggestions('@former', new AbortController().signal);

        expect(rows.map(row => row.label)).toEqual([t('message.accountActorFormerMember')]);
        expect(rows.map(row => row.label)).not.toContain(ALICE.profile.name);
    });

    it.each(['participant', 'plugin'] as const)('lets an external Composer host apply a %s reference to the actual Discussion input and retires it on unmount', async (kind) => {
        const emittedActions: unknown[] = [];
        let sent: Promise<unknown> | undefined;
        const onSend = vi.fn((content: unknown) => {
            sent = postDiscussionComposerContent(fixture!.context.hostApi, ref, DiscussionPostInputV1Schema.parse({
                discussionId: ref.discussionId, localId: 'external-question', content,
            }));
        });
        let current = true;
        const retirements = new Set<() => void>();
        const lifetime: ServerAccountScopeLifetime = {
            scope: accountLifetime.scope,
            isCurrent: () => current,
            onRetire: callback => {
                retirements.add(callback);
                return { dispose: () => { retirements.delete(callback); } };
            },
        };
        const screen = await render(<Harness onSend={onSend} lifetime={lifetime} />);
        let fixture: PluginUiTestkit | undefined;
        const observations: unknown[] = [];
        const handlers = createComposerPresentationHostHandlers({ scope: accountLifetime.scope, owner: {
            identity: { pluginId: 'acme.discussion', localId: 'review' },
            occurrenceId: 'external-review-v1', surfaceInstanceKey: 'mounted-review',
        }, publishComposerSnapshot: ({ snapshot }) => fixture?.emitComposerSnapshot(snapshot.ref, snapshot) });
        const request = (method: PluginUiHostApiRequestEnvelopeV1['method'], payload: unknown): PluginUiHostApiRequestEnvelopeV1 => ({
            version: 1, requestId: `external:${method}`,
            surface: { pluginId: 'acme.discussion', contributionId: 'review', surfaceId: 'review',
                placement: 'composerSurface', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] },
            method, payload: PluginUiJsonValueV1Schema.parse(payload),
        });
        const ref = { kind: 'discussion', discussionId: 'discussion-1' } as const;
        try {
            fixture = await createPluginUiTestkit({
                identity: { instanceId: 'external-review', mountNonce: 'external-review-1' },
                authorPlugin: { id: 'acme.discussion', version: '0.0.0' },
                surface: null, surfaceContext: createSurfaceContextFixture({ target: { kind: 'app' } }),
                // This author fixture has no visual control. Only its physical
                // renderer is absent; the product input and both wire owners run.
                adapter: { mount: async () => ({ snapshot: async () => ({ revision: 0, nodes: [] }),
                    update: async () => {}, invoke: async () => {}, dispose: async () => {} }) },
                handlers: {
                    executeAction: async ({ action, input }) => {
                        expect(action).toBe('discussion.post');
                        const post = DiscussionPostInputV1Schema.parse(input);
                        emittedActions.push({ action, input: post });
                        return null;
                    },
                    readComposer: async ({ ref, signal }) => ComposerReadResultV1Schema.parse(await handlers.readDiscussionComposer!(request('readDiscussionComposer', { ref }), { signal })),
                    applyComposer: async ({ ref, transaction, signal }) => ComposerTransactionResultV1Schema.parse(await handlers.applyComposer!(request('applyComposer', { ref, transaction }), { signal })),
                    focusComposer: async ({ ref, signal }) => ComposerFocusResultV1Schema.parse(await handlers.focusComposer!(request('focusComposer', { ref }), { signal })),
                    watchComposer: async ({ ref, signal }) => {
                        await handlers.watchComposer!(request('watchComposer', { ref, subscriptionId: 'external-watch' }), { signal });
                        return { dispose: () => { void handlers.disposeHostResource!(request('disposeHostResource', { subscriptionId: 'external-watch' })); } };
                    },
                    acquireComposerInputLock: async ({ ref, request: lock, signal }) => {
                        await handlers.acquireComposerInputLock!(request('acquireComposerInputLock', { ref, request: lock, subscriptionId: 'external-lock' }), { signal });
                        return { dispose: () => { void handlers.disposeHostResource!(request('disposeHostResource', { subscriptionId: 'external-lock' })); } };
                    },
                },
            });
            const hostApi = fixture.context.hostApi;
            const read = await hostApi.readComposer(ref);
            expect(read).toMatchObject({ status: 'ready', snapshot: { ref, text: '', capabilities: { references: true, attachments: false } } });
            expect(await hostApi.focusComposer(ref)).toMatchObject({ status: 'focused' });
            await hostApi.watchComposer(ref, snapshot => { observations.push(snapshot); });
            const reference = { kind: MENTION_KIND_V1.session, ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'reviewer-session'),
                label: 'Reviewer', token: '@Reviewer', start: 0, end: 9 };
            const participantQuestion = createDiscussionParticipantQuestion('reviewer-session');
            const pluginReference = { kind: 'happier.composerReference', ref: 'composerReference:issue-42', label: 'Issue 42',
                composerReference: { pluginId: 'acme.issues', localId: 'issues' }, composerReferenceTrigger: '@' as const,
                token: '[Issue 42](happier-ref:composerReference:issue-42)', start: 0,
                end: '[Issue 42](happier-ref:composerReference:issue-42)'.length };
            const question = kind === 'participant' ? { ...participantQuestion, reference } : {
                draft: { text: `${pluginReference.token} Check this` }, reference: pluginReference,
                content: { v: 1, parts: [{ t: 'reference', reference: { kind: pluginReference.kind, ref: pluginReference.ref,
                    label: pluginReference.label, token: pluginReference.token, composerReference: pluginReference.composerReference,
                    composerReferenceTrigger: pluginReference.composerReferenceTrigger } }, { t: 'text', text: ' Check this' }] },
            };
            const { text } = question.draft;
            await act(async () => {
                expect(await applyDiscussionParticipantReference(hostApi, ref, { ...question.draft, reference: question.reference })).toMatchObject({ status: 'applied' });
            });
            expect(composerInput(screen).props.value).toBe(text);
            expect(observations).toContainEqual(expect.objectContaining({ text, references: [expect.objectContaining(question.reference)] }));
            let lock: Awaited<ReturnType<typeof hostApi.acquireComposerInputLock>> | undefined;
            await act(async () => { lock = await hostApi.acquireComposerInputLock(ref, { mode: 'editAndSubmit', reason: 'Preparing review' }); });
            expect(composerInput(screen).props.editable).toBe(false);
            const locked = await hostApi.readComposer(ref);
            expect(locked.status).toBe('ready');
            if (locked.status !== 'ready') throw new Error('Mounted composer became unavailable');
            expect(await hostApi.applyComposer(ref, { expectedRevision: locked.snapshot.revision, operations: [{ kind: 'text.clear' }] })).toMatchObject({ status: 'notEditable' });
            await act(async () => { lock?.dispose(); });
            await act(async () => {
                screen.root.findAll((node) => node.props.testID === 'new-session-composer-send' && typeof node.props.onPress === 'function')[0]!.props.onPress();
            });
            await sent;
            expect(onSend).toHaveBeenCalledExactlyOnceWith(question.content);
            expect(emittedActions).toEqual([{ action: 'discussion.post', input: {
                discussionId: ref.discussionId, localId: 'external-question', content: question.content,
            } }]);
            await act(async () => {
                current = false;
                for (const retire of retirements) retire();
            });
            expect(await hostApi.readComposer(ref)).toMatchObject({ status: 'unavailable' });
            expect(await hostApi.applyComposer(ref, {
                expectedRevision: 0, operations: [{ kind: 'text.set', text: 'retired account write' }],
            })).toMatchObject({ status: 'composerUnavailable' });
            await act(async () => { screen.unmount(); });
            expect(await hostApi.readComposer(ref)).toMatchObject({ status: 'unavailable' });
            expect(await hostApi.applyComposer(ref, {
                expectedRevision: 0, operations: [{ kind: 'text.set', text: 'retired write' }],
            })).toMatchObject({ status: 'composerUnavailable' });
        } finally { await fixture?.dispose(); handlers.dispose(); }
    });

    it('does not let a control composition apply to a Discussion in another Home', async () => {
        const screen = await render(<Harness />);
        const applier = createComposerPresentationTransactionApplier({
            scope: { serverId: 'other-home', accountId: accountLifetime.scope.accountId },
            composerAttachmentsById: {},
        });
        expect(applier.apply({ ref: { kind: 'discussion', discussionId: 'discussion-1' },
            admittedContributor: { identity: { pluginId: 'acme.discussion', localId: 'control' }, occurrenceId: 'foreign-control' },
            transaction: { expectedRevision: 0, operations: [{ kind: 'text.set', text: 'Foreign control write' }] },
        })).toMatchObject({ status: 'composerUnavailable' });
        expect(composerInput(screen).props.value).toBe('');
    });

    it.each([
        { serverId: 'other-home', accountId: 'viewer-b' },
        { serverId: 'server-b', accountId: 'other-account' },
    ])('captures the Home and Account rather than resolving another mounted Discussion with the same raw id: %j', async (scope) => {
        await render(<Harness initial={{ text: 'Private draft', mentions: [] }} />);
        const handlers = createComposerPresentationHostHandlers({ scope, owner: {
            identity: { pluginId: 'acme.discussion', localId: 'review' },
            occurrenceId: 'external-review-v1', surfaceInstanceKey: 'mounted-review',
        } });
        const request: PluginUiHostApiRequestEnvelopeV1 = { version: 1, requestId: 'foreign-read',
            surface: { pluginId: 'acme.discussion', contributionId: 'review', surfaceId: 'review',
                placement: 'composerSurface', platform: 'web', channel: 'internal', resourceScope: [], diagnostics: [] },
            method: 'readComposer', payload: { ref: { kind: 'discussion', discussionId: 'discussion-1' } },
        };
        try { expect(await handlers.readComposer!(request)).toMatchObject({ status: 'unavailable' }); }
        finally { handlers.dispose(); }
    });

    it('offers people and admitted Session references with no agent setup chip or agent history', async () => {
        const screen = await render(<Harness />);

        expect(composer().autocompleteKinds).toEqual(['accountMention', 'session', 'composerReference']);
        expect(composer().engineControls).toBe('none');
        // Dictation only writes words into the field; no conversational Voice is mounted here.
        expect(composer().voiceAffordance).toBe('dictation');
        expect(composer().messageHistory).toBe('none');
        // Attach (the Session's own file intake) and `@` as a control (lab T2-A); no agent, engine or session chip.
        expect((composer().extraActionChips ?? []).map((chip) => chip.key)).toEqual(['attachments-add', 'mention']);
        expect(composer().sessionId).toBeUndefined();
        // An empty draft stays editable; Send's emptiness is the composer's own decision.
        expect(composer().disabled).toBe(false);
        expect(composer().inputAccessibilityLabel).toBeTruthy();
        expect(composer().inputAccessibilityLabel).toBe(composer().placeholder);
        expect(typeof composer().onSend).toBe('function');
        expect(screen.findByTestId('agent-input-prompt-library')).toBeNull();
    });

    it('writes the mention trigger after the draft when `@` is pressed, so the people suggestions open on it', async () => {
        const values: DiscussionComposerValue[] = [];
        await render(<Harness initial={{ text: 'Can you check', mentions: [] }} onValue={(value) => values.push(value)} />);
        // `@` is reached wherever the person placed it (bar or the + menu); its action writes the trigger.
        const mention = (composer().extraActionChips ?? []).find((chip) => chip.key === 'mention') as unknown as
            { collapsedAction: (input: { tint: string; dismiss: () => void }) => { onPress: () => void } };
        await act(async () => { mention.collapsedAction({ tint: '#000', dismiss: () => {} }).onPress(); });
        expect(values.at(-1)?.text).toBe('Can you check @');
    });

    it('takes the caret once when opened for writing (a comment just started), and only then', async () => {
        for (const focusOnOpen of [true, false]) {
            const screen = await render(<DiscussionComposer draftAddress={{ kind: 'discussion', discussionId: 'draft-address' }}
                scope={accountLifetime.scope} accountLifetime={accountLifetime} address={{ serverId: 'server-b' }}
                availability="available" value={{ text: '', mentions: [] }} onChange={() => {}} disabled={false} onSend={() => {}}
                {...(focusOnOpen ? { focusOnOpen } : {})} />);
            const focus = vi.fn();
            const report = composer() as unknown as { onComposerFocusRequestChange: (request: (() => void) | null) => void };
            await act(async () => { report.onComposerFocusRequestChange(focus); });
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 32)); });
            // A later binding (the composer remounting its input) does not steal the caret again.
            await act(async () => { report.onComposerFocusRequestChange(focus); });
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 32)); });
            expect(focus).toHaveBeenCalledTimes(focusOnOpen ? 1 : 0);
            await screen.unmount();
        }
    });

    it('keeps the prompt library for agent follow-up inputs that disable message history', async () => {
        const screen = await render(<AgentInput value="" onChangeText={() => {}} onSend={() => {}} messageHistory="none" autocompleteKinds={[]} autocompleteSuggestions={async () => []} placeholder="Follow up" />);
        expect(screen.findByTestId('agent-input-prompt-library')).not.toBeNull();
    });

    it.each([undefined, 'discussion-1'])('names the real human submit action for discussion %s', async (discussionId) => {
        const onSend = vi.fn();
        const screen = await render(<DiscussionComposer draftAddress={{ kind: 'discussion', discussionId: 'draft-address' }}
            scope={{ serverId: 'server-b', accountId: 'viewer-b' }}
            accountLifetime={accountLifetime}
            address={{ serverId: 'server-b' }}
            discussionId={discussionId}
            availability="available"
            value={{ text: 'Please review this', mentions: [] }}
            onChange={() => {}}
            disabled={false}
            onSend={onSend}
        />);
        const submit = screen.root.findAll((node) => node.props.testID === 'new-session-composer-send'
            && typeof node.type === 'string' && typeof node.props.onPress === 'function').at(-1)!;
        // The canonical composer testkit translates to keys; assert the human-send identity
        // at the real button, rather than the adapter prop or the unrelated new-session default.
        expect(submit.props.accessibilityLabel).toBe('common.send');
        await act(async () => { submit.props.onPress(); });
        expect(onSend).toHaveBeenCalledWith({ v: 1, parts: [{ t: 'text', text: 'Please review this' }] });
    });

    it('sends a file with no text through the shared Session intake, as an attachment part with its source', async () => {
        const onSend = vi.fn();
        await render(<DiscussionComposer draftAddress={{ kind: 'discussion', discussionId: 'attachment-only' }}
            scope={accountLifetime.scope} accountLifetime={accountLifetime} address={{ serverId: 'server-b' }}
            discussionId="attachment-only" availability="available" value={{ text: '', mentions: [] }}
            onChange={() => {}} disabled={false} onSend={onSend} />);
        await act(async () => { composer().onAttachmentsAdded?.([], { sources: [{ kind: 'memory', name: 'notes.txt', bytes: new Uint8Array([1, 2, 3]) }] }); });
        // The tray shows the file as a Session's does, and an empty field can still send it.
        expect(composer().attachmentRowItems?.map(item => item.label)).toEqual(['notes.txt']);
        expect(composer().hasSendableAttachments).toBe(true);
        await act(async () => { composer().onSend?.(); });
        await vi.waitFor(async () => {
            await settle();
            expect({ sent: onSend.mock.calls.length, tray: composer().attachmentRowItems }).toMatchObject({ sent: 1 });
        }, { timeout: 5000 });
        const [content, submission] = onSend.mock.calls[0]!;
        expect(content).toMatchObject({ v: 1, parts: [{ t: 'attachment', attachment: { kind: 'file', name: 'notes.txt', file: { sizeBytes: 3 } } }] });
        expect(submission.sources).toHaveLength(1);
        // An observed success clears only the sent file from the tray.
        await act(async () => { submission.settle('observed_success'); });
        expect(composer().attachmentRowItems ?? []).toEqual([]);
    });

    it('types @Ali in the real composer, picks Alice and posts her as a mention part', async () => {
        const onSend = vi.fn();
        const screen = await render(<Harness onSend={onSend} />);

        await act(async () => {
            composerInput(screen).props.onComposerFocus?.();
        });
        await act(async () => {
            changeTextTestInstance(composerInput(screen), '@Ali');
        });
        await settle();
        // The picker lists who this discussion can mention; Enter picks the highlighted person.
        expect(screen.getTextContent()).toContain('Alice Ng');
        await act(async () => {
            composerInput(screen).props.onComposerKeyPress?.({ nativeEvent: { key: 'Enter' }, preventDefault: () => undefined });
        });
        await settle();
        const token = formatInlineReferenceTokenV1({ label: 'Alice Ng', ref: 'account:account-alice' });
        expect(composerInput(screen).props.value).toBe(`${token} `);

        await act(async () => {
            const input = composerInput(screen);
            const text = `${token} can you look?`;
            // The native editor reports the retained chip on an append. A
            // text-only synthetic event with references: [] means deletion.
            if (typeof input.props.onChangeText === 'function') changeTextTestInstance(input, text);
            else input.props.onComposerChange({ nativeEvent: { text, selection: { start: text.length, end: text.length },
                eventCount: 1, references: input.props.references } });
        });
        await act(async () => {
            await screen.root.findAll((node) => node.props.testID === 'new-session-composer-send' && typeof node.props.onPress === 'function')[0]!.props.onPress();
        });

        expect(onSend).toHaveBeenCalledWith({
            v: 1,
            parts: [
                { t: 'mention', participant: { kind: 'account', accountId: 'account-alice' } },
                { t: 'text', text: ' can you look?' },
            ],
        });
    });

    it('selects an invited Session through the ordinary picker and submits a typed executable mention', async () => {
        const store = getStorage();
        const previous = store.getState();
        store.getState().applySessions([createSessionFixture({ id: 'invited-review-agent', serverId: 'server-b',
            metadata: { path: '/review', host: 'review-machine', machineId: 'review-machine-id', flavor: 'codex', homeDir: '/home/reviewer',
                summary: { text: 'Review agent', updatedAt: 1 } } })]);
        participantRoster = DiscussionParticipantsListResponseV1Schema.parse({
            discussionId: 'discussion-1', ownerAccountId: ALICE.accountId, access: 'edit', grants: [],
            accountActors: [{ v: 1, accountId: ALICE.accountId, accessibility: 'current', profile: ALICE.profile }],
            participants: [{ participant: { kind: 'session', sessionId: 'invited-review-agent' },
                answerPolicy: 'when_addressed', createdAt: 1 }],
        });
        const onSend = vi.fn();
        const screen = await render(<Harness onSend={onSend} />);
        try {
            await act(async () => {
                composerInput(screen).props.onComposerFocus?.();
                changeTextTestInstance(composerInput(screen), '@Review');
            });
            await settle();
            expect(screen.getTextContent()).toContain('Review agent');
            expect(screen.getTextContent()).toContain('review-machine');
            const rows = await composer().autocompleteSuggestions('@Review', new AbortController().signal);
            expect(rows[0]?.icon).toMatchObject({ props: {
                agentId: 'codex', machineId: 'review-machine-id', serverId: 'server-b',
            } });
            await act(async () => {
                composerInput(screen).props.onComposerKeyPress?.({ nativeEvent: { key: 'Enter' }, preventDefault: () => undefined });
            });
            await settle();
            expect(composer().structuredInputMentions).toEqual([expect.objectContaining({
                kind: MENTION_KIND_V1.session, ref: 'session:invited-review-agent',
            })]);
            await screen.pressByTestIdAsync('new-session-composer-send');
            expect(onSend).toHaveBeenCalledWith({ v: 1, parts: [
                { t: 'mention', participant: { kind: 'session', sessionId: 'invited-review-agent' } },
                { t: 'text', text: ' ' },
            ] });
        } finally {
            await screen.unmount();
            setScreenSharingPrivacyActive(false);
            store.setState(previous, true);
        }
    });

    it('offers current roster Sessions and inert reserved model slots, including uncached or offline participants', async () => {
        const store = getStorage();
        const previous = store.getState();
        const recentActivityAt = Date.now() - 180_000;
        store.getState().applySessions([
            createSessionFixture({ id: 'invited-bot', serverId: 'server-b', active: false,
                meaningfulActivityAt: recentActivityAt, metadata: { path: '/review', host: 'Review machine',
                    summary: { text: 'Review the opening plan', updatedAt: recentActivityAt } } }),
            createSessionFixture({ id: 'outsider-session', serverId: 'server-b', active: true }),
        ]);
        const launch = { executionTarget: { serverId: 'server-b', machineId: 'machine-b' },
            directory: { kind: 'path', path: '/review' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        const response = DiscussionParticipantsListResponseV1Schema.parse({
            discussionId: 'discussion-1', ownerAccountId: ALICE.accountId, access: 'edit', grants: [],
            participants: [
                { participant: { kind: 'session', sessionId: 'invited-bot' }, answerPolicy: 'when_addressed', createdAt: 1 },
                { participant: { kind: 'model', participantSlotId: 'bound-slot' }, sessionId: 'model-session', launch,
                    answerPolicy: 'when_addressed', createdAt: 2 },
                { participant: { kind: 'model', participantSlotId: 'unbound-slot' }, sessionId: null, launch,
                    answerPolicy: 'when_addressed', createdAt: 3 },
            ],
        });
        const screen = await render(<Harness roster={response} />);
        try {
            const rows = await composer().autocompleteSuggestions('@session:', new AbortController().signal);
            const references = rows.flatMap(({ structuredInput }) => structuredInput
                && structuredInput.kind === MENTION_KIND_V1.session && 'ref' in structuredInput
                ? [structuredInput.ref] : []);
            expect(references.sort()).toEqual(['session:invited-bot', 'session:model-session']);
            const named = rows.find(row => row.key === 'session-invited-bot');
            expect(named?.label).toBe('Review the opening plan');
            expect(named?.description).toContain(formatRelativeTimeShort(recentActivityAt, Date.now()));
            expect(named?.description).toContain('Review machine');
            expect(rows.find(row => row.key === 'discussion-model:unbound-slot')?.structuredInput).toMatchObject({
                kind: DISCUSSION_MODEL_SLOT_MENTION_KIND, ref: 'discussion-participant:unbound-slot',
            });
            const uncached = rows.find(row => row.key === 'session-model-session');
            expect(uncached).toBeDefined();
            expect(uncached?.description).toBe(uncached?.label);
            for (const row of rows.filter(row => row.structuredInput?.kind === MENTION_KIND_V1.session)) {
                expect(row.description).not.toContain('invited-bot');
                expect(row.description).not.toContain('model-session');
            }
            await act(async () => {
                store.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { 'server-b': ['private'] } });
                store.getState().setSessionTagAssignmentsOptimistic('server-b', 'invited-bot', ['private']);
                setScreenSharingPrivacyActive(true);
            });
            const privateRows = await composer().autocompleteSuggestions('@session:', new AbortController().signal);
            expect(privateRows.map(row => row.key)).not.toContain('session-invited-bot');
            expect(privateRows.map(row => row.key)).toContain('session-model-session');
            await act(async () => setScreenSharingPrivacyActive(false));
            await screen.update(<Harness roster={{ ...response, participants: [] }} />);
            const afterRemoval = await composer().autocompleteSuggestions('@session:', new AbortController().signal);
            expect(afterRemoval).toEqual([]);
        } finally {
            await screen.unmount();
            setScreenSharingPrivacyActive(false);
            store.setState(previous, true);
        }
    });

    // New Discussion (C3 §6.1): before a roster exists, the chosen invitees are who `@` can address
    // in the first message; nobody else, and no roster read.
    it('offers only the chosen invitees before the Discussion exists', async () => {
        const store = getStorage();
        const previous = store.getState();
        store.getState().applySessions([
            createSessionFixture({ id: 'invited-bot', serverId: 'server-b', active: true }),
            createSessionFixture({ id: 'outsider-session', serverId: 'server-b', active: true }),
        ]);
        const invited = { participants: [{ kind: 'session' as const, sessionId: 'invited-bot' }, { kind: 'account' as const, accountId: ALICE.accountId }],
            accounts: new Map([[ALICE.accountId, { v: 1 as const, serverId: 'server-b', accountId: ALICE.accountId, profile: ALICE.profile }]]) };
        const screen = await render(<DiscussionComposer draftAddress={{ kind: 'discussion', discussionId: 'draft-address' }} scope={accountLifetime.scope} accountLifetime={accountLifetime}
            address={{ serverId: 'server-b' }} availability="available" value={{ text: '', mentions: [] }}
            onChange={() => undefined} disabled={false} onSend={() => undefined} invited={invited} />);
        try {
            const sessions = await composer().autocompleteSuggestions('@session:', new AbortController().signal);
            expect(sessions.flatMap(({ structuredInput }) => structuredInput && 'ref' in structuredInput ? [structuredInput.ref] : []))
                .toEqual(['session:invited-bot']);
            const people = await composer().autocompleteSuggestions('@', new AbortController().signal);
            expect(people.filter(row => row.kind === 'accountMention').map(row => row.key)).toEqual([ALICE.accountId]);
            await act(async () => {
                store.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { 'server-b': ['private'] } });
                store.getState().setSessionTagAssignmentsOptimistic('server-b', 'invited-bot', ['private']);
                setScreenSharingPrivacyActive(true);
            });
            expect(await composer().autocompleteSuggestions('@session:', new AbortController().signal)).toEqual([]);
            await act(async () => setScreenSharingPrivacyActive(false));

        } finally {
            await screen.unmount();
            setScreenSharingPrivacyActive(false);
            store.setState(previous, true);
        }
    });

    it.each([accountLifetime.scope.accountId, ALICE.accountId])('omits the viewer from the ordinary picker with owner %s', async (ownerAccountId) => {
        participantRoster = DiscussionParticipantsListResponseV1Schema.parse({
            discussionId: 'discussion-1', ownerAccountId, access: 'edit', participants: [],
            accountActors: [
                { v: 1, accountId: ALICE.accountId, accessibility: 'current', profile: ALICE.profile },
                { v: 1, accountId: accountLifetime.scope.accountId, accessibility: 'current', profile: null },
            ],
            grants: [{ principal: { kind: 'account', accountId: ALICE.accountId }, accessLevel: 'edit',
                createdByAccountId: accountLifetime.scope.accountId, createdAt: 1,
                display: { name: ALICE.profile.name, username: ALICE.profile.username } },
                ...(ownerAccountId !== accountLifetime.scope.accountId ? [{
                    principal: { kind: 'account', accountId: accountLifetime.scope.accountId }, accessLevel: 'edit',
                    createdByAccountId: ownerAccountId, createdAt: 1, display: { name: null },
                }] : [])],
        });
        await render(<Harness />);
        const rows = await composer().autocompleteSuggestions('@', new AbortController().signal);
        expect(rows.filter(row => row.kind === 'accountMention').map(row => row.key)).toEqual([ALICE.accountId]);
    });

    it.each(['retired', 'aborted'] as const)('does not publish local suggestions after the query is %s', async (reason) => {
        const value = DiscussionParticipantsListResponseV1Schema.parse({
            discussionId: 'discussion-1', ownerAccountId: ALICE.accountId, access: 'edit', grants: [],
            participants: [{ participant: { kind: 'session', sessionId: 'late-session' },
                answerPolicy: 'when_addressed', createdAt: 1 }],
        });
        participantRoster = value;
        let current = true;
        await render(<Harness lifetime={{ ...accountLifetime, isCurrent: () => current }} />);
        const query = new AbortController();
        const suggestions = composer().autocompleteSuggestions('@session:', query.signal);
        if (reason === 'retired') current = false;
        else query.abort();
        expect(await suggestions).toEqual([]);
    });

    it('offers Retry when the people search fails, and retrying searches again', async () => {
        const { resolveComposerSuggestionKind } = await import('@/components/autocomplete/composerSuggestionKinds');
        participantRoster = null;
        const refresh = vi.fn(async () => defaultRoster());
        await render(<Harness onRefreshParticipants={refresh} />);
        const failedHandler = composer().autocompleteSuggestions;

        const rows = await failedHandler('@al', new AbortController().signal);
        expect(rows.map((row) => row.label)).toEqual([t('session.collaboration.discussion.retry')]);
        await act(async () => {
            await resolveComposerSuggestionKind('accountMention').applySelection!({
                suggestion: rows[0]!,
                inputText: '@al',
                selection: { start: 3, end: 3 },
                activeWord: { offset: 0, endOffset: 3 },
            });
        });

        // A new handler is what makes the open picker ask again for the same token.
        expect(composer().autocompleteSuggestions).not.toBe(failedHandler);
        const retried = await composer().autocompleteSuggestions('@al', new AbortController().signal);
        expect(retried.map((row) => row.label)).toEqual(['Alice Ng']);
        expect(refresh).toHaveBeenCalledOnce();
    });

    it('keeps the last picker row for "Type more to narrow" when the authorized roster has more matches', async () => {
        participantRoster = DiscussionParticipantsListResponseV1Schema.parse({
            discussionId: 'discussion-1', ownerAccountId: 'account-0', access: 'edit',
            grants: Array.from({ length: 12 }, (_, index) => ({ principal: { kind: 'account', accountId: `account-${index}` }, accessLevel: 'edit', createdByAccountId: 'viewer-b', createdAt: 0, display: { name: `Alice ${index}` } })),
            accountActors: Array.from({ length: 12 }, (_, index) => ({ v: 1, accountId: `account-${index}`,
                accessibility: 'current' as const, profile: { name: `Alice ${index}`, firstName: null, lastName: null, username: null, avatarUrl: null } })),
            participants: [],
        });
        await render(<Harness />);

        const rows = await composer().autocompleteSuggestions('@a', new AbortController().signal);

        expect(rows).toHaveLength(12);
        expect(rows.at(-1)?.label).toBe(t('agentInput.suggestionTypeMoreToNarrow'));
    });

    it('restores a drafted mention into the composer bound to its visible token', async () => {
        const token = formatInlineReferenceTokenV1({ label: 'bob', ref: 'account:account-bob' });
        const mention = { kind: 'happier.account', ref: 'account:account-bob', tokenText: token, start: 3, end: 3 + token.length };
        await render(<Harness initial={{ text: `Hi ${token}`, mentions: [mention] }} />);

        expect(composer().value).toBe(`Hi ${token}`);
        expect(composer().structuredInputMentions).toEqual([
            mention,
        ]);
    });

    it('uses the flushed text for person attention when a pending edit breaks the selected mention boundary', async () => {
        const confirm = vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        const onSend = vi.fn();
        const token = formatInlineReferenceTokenV1({ label: 'bob', ref: 'account:account-bob' });
        await render(<Harness initial={{ text: `Hi ${token}`, mentions: [
            { kind: 'happier.account', ref: 'account:account-bob', tokenText: token, start: 3, end: 3 + token.length },
        ] }} onSend={onSend} />);

        await act(async () => composer().onSend?.({ inputTextOverride: 'Hi @bob2' }));

        expect(confirm).toHaveBeenCalled();
        expect(onSend).toHaveBeenCalledWith({ v: 1, parts: [{ t: 'text', text: 'Hi @bob2' }] });
        expect(readDiscussionMentionedParticipantIdsV1(onSend.mock.calls[0]![0]).mentionedAccountIds).toEqual([]);
    });

    it('publishes actual edits and stops on blur or lock through the exact Discussion presence transport', async () => {
        const sent: Array<readonly [string, unknown]> = [];
        const target = { serverId: 'server-b', discussionId: 'discussion-1' };
        // The real presence owner runs; only the authenticated Socket transport is substituted.
        const detach = attachSessionHumanPresenceSocket({ serverId: 'server-b', accountId: 'viewer-b', transport: {
            isConnected: () => true,
            subscribeStatus: () => () => undefined,
            subscribeSnapshot: () => () => undefined,
            send: (event, payload) => { sent.push([event, payload]); },
            sendWithAck: async (_event, payload) => {
                const request = SessionHumanPresenceVisibleReplaceV1Schema.parse(payload);
                return { v: 1, ok: true, admittedSessionIds: request.sessionIds, admittedLocations: request.locations ?? [] };
            },
        } });
        const unregister = registerDiscussionHumanPresence(target, accountLifetime);
        try {
            const screen = await render(<Harness />);
            await settle();
            await act(async () => { composer().onChangeText('Ready'); });
            expect(sent.filter(([event]) => event === 'session-human-presence:typing-set').at(-1)?.[1]).toEqual({ v: 1, discussionId: 'discussion-1', typing: true });

            await act(async () => { composer().onComposerFocusChange?.(false); });
            expect(sent.at(-1)?.[1]).toEqual({ v: 1, discussionId: 'discussion-1', typing: false });
            await act(async () => { composer().onChangeText('Ready again'); });
            await screen.update(<Harness disabled />);
            expect(composer().disabled).toBe(true);
            expect(sent.at(-1)?.[1]).toEqual({ v: 1, discussionId: 'discussion-1', typing: false });
        } finally {
            unregister();
            detach();
        }
    });
});
