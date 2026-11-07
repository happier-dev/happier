import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { changeTextTestInstance, createDeferred, createSessionFixture, renderScreen } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { t } from '@/text';
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
 * it. Only system boundaries are replaced: the discussion's mention-candidate read and its typing
 * presence transport (plus the testkit's platform modules).
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
}>;

installAgentInputCommonModuleMocks();
vi.mock('expo-image', () => ({ Image: (props: Record<string, unknown>) => React.createElement('Image', props, null) }));

const mounted = vi.hoisted(() => ({ screen: null as null | { root: { findByType: (type: unknown) => { props: Record<string, unknown> } } } }));
const readParticipants = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/discussions/discussionActions', () => ({ createDiscussionClient: () => ({ participants: readParticipants }) }));

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
    const input = screen.root.findAll((node) => node.props.testID === 'new-session-composer-input' && typeof node.props.onChangeText === 'function').at(-1);
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
}>): React.ReactElement {
    const [value, setValue] = React.useState<DiscussionComposerValue>(props.initial ?? { text: '', mentions: [] });
    return (
        <DiscussionComposer
            scope={accountLifetime.scope}
            accountLifetime={props.lifetime ?? accountLifetime}
            address={{ serverId: 'server-b' }}
            discussionId="discussion-1"
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
        readParticipants.mockReset();
        readParticipants.mockResolvedValue({ kind: 'succeeded', value: {
            discussionId: 'discussion-1', ownerAccountId: ALICE.accountId, access: 'edit',
            grants: [{ principal: { kind: 'account', accountId: ALICE.accountId }, accessLevel: 'edit', createdByAccountId: ALICE.accountId, createdAt: 0, display: { name: ALICE.profile.name, username: ALICE.profile.username } }],
            participants: [],
        } });
    });

    it('does not read the participant roster while the picker is closed, then reads once for a demanded query', async () => {
        const screen = await render(<Harness />);
        try {
            await act(async () => { composerInput(screen).props.onFocus?.(); });
            for (let index = 0; index < 25; index += 1) {
                await act(async () => { changeTextTestInstance(composerInput(screen), `Please review this change ${index}`); });
            }
            await settle();
            expect(readParticipants).not.toHaveBeenCalled();
            await composer().autocompleteSuggestions('@session:', new AbortController().signal);
            expect(readParticipants).toHaveBeenCalledTimes(1);
            await act(async () => { composerInput(screen).props.onBlur?.(); });
            await settle();
            expect(readParticipants).toHaveBeenCalledTimes(1);
        } finally { await screen.unmount(); }
    });

    it('lets an external Composer host apply a participant reference to the actual Discussion input and retires it on unmount', async () => {
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
            const question = createDiscussionParticipantQuestion('reviewer-session');
            const { text } = question.draft;
            await act(async () => {
                expect(await applyDiscussionParticipantReference(hostApi, ref, { ...question.draft, reference })).toMatchObject({ status: 'applied' });
            });
            expect(composerInput(screen).props.value).toBe(text);
            expect(observations).toContainEqual(expect.objectContaining({ text, references: [expect.objectContaining(reference)] }));
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

        expect(composer().autocompleteKinds).toEqual(['accountMention', 'session']);
        expect(composer().engineControls).toBe('none');
        // Dictation only writes words into the field; no conversational Voice is mounted here.
        expect(composer().voiceAffordance).toBe('dictation');
        expect(composer().messageHistory).toBe('none');
        // `@` as a control is the one chip (lab T2-A); no agent, engine or session chip.
        expect((composer().extraActionChips ?? []).map((chip) => chip.key)).toEqual(['mention']);
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
        const screen = await render(<Harness initial={{ text: 'Can you check', mentions: [] }} onValue={(value) => values.push(value)} />);
        await screen.pressByTestIdAsync('agent-input-mention-chip');
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
        const screen = await render(<DiscussionComposer
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

    it('types @Ali in the real composer, picks Alice and posts her as a mention part', async () => {
        const onSend = vi.fn();
        const screen = await render(<Harness onSend={onSend} />);

        await act(async () => {
            composerInput(screen).props.onFocus?.();
        });
        await act(async () => {
            changeTextTestInstance(composerInput(screen), '@Ali');
        });
        await settle();
        // The picker lists who this discussion can mention; Enter picks the highlighted person.
        expect(readParticipants).toHaveBeenCalledWith('discussion-1', expect.any(AbortSignal));
        expect(screen.getTextContent()).toContain('Alice Ng');
        await act(async () => {
            composerInput(screen).props.onKeyPress?.({ nativeEvent: { key: 'Enter' }, preventDefault: () => undefined });
        });
        await settle();
        const token = formatInlineReferenceTokenV1({ label: 'Alice Ng', ref: 'account:account-alice' });
        expect(composerInput(screen).props.value).toBe(`${token} `);

        await act(async () => {
            changeTextTestInstance(composerInput(screen), `${token} can you look?`);
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
        readParticipants.mockResolvedValue({ kind: 'succeeded', value: DiscussionParticipantsListResponseV1Schema.parse({
            discussionId: 'discussion-1', ownerAccountId: ALICE.accountId, access: 'edit', grants: [],
            participants: [{ participant: { kind: 'session', sessionId: 'invited-review-agent' },
                answerPolicy: 'when_addressed', createdAt: 1 }],
        }) });
        const onSend = vi.fn();
        const screen = await render(<Harness onSend={onSend} />);
        try {
            await act(async () => {
                composerInput(screen).props.onFocus?.();
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
                composerInput(screen).props.onKeyPress?.({ nativeEvent: { key: 'Enter' }, preventDefault: () => undefined });
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
            store.setState(previous, true);
        }
    });

    it('offers current roster Sessions and inert reserved model slots, including uncached or offline participants', async () => {
        const store = getStorage();
        const previous = store.getState();
        store.getState().applySessions([
            createSessionFixture({ id: 'invited-bot', serverId: 'server-b', active: false }),
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
        readParticipants.mockResolvedValueOnce({ kind: 'succeeded', value: response })
            .mockResolvedValueOnce({ kind: 'succeeded', value: { ...response, participants: [] } });
        const screen = await render(<Harness />);
        try {
            const rows = await composer().autocompleteSuggestions('@session:', new AbortController().signal);
            const references = rows.flatMap(({ structuredInput }) => structuredInput
                && structuredInput.kind === MENTION_KIND_V1.session && 'ref' in structuredInput
                ? [structuredInput.ref] : []);
            expect(references.sort()).toEqual(['session:invited-bot', 'session:model-session']);
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
            const afterRemoval = await composer().autocompleteSuggestions('@session:', new AbortController().signal);
            expect(afterRemoval).toEqual([]);
            expect(readParticipants).toHaveBeenCalledTimes(2);
        } finally {
            await screen.unmount();
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
        const screen = await render(<DiscussionComposer scope={accountLifetime.scope} accountLifetime={accountLifetime}
            address={{ serverId: 'server-b' }} availability="available" value={{ text: '', mentions: [] }}
            onChange={() => undefined} disabled={false} onSend={() => undefined} invited={invited} />);
        try {
            const sessions = await composer().autocompleteSuggestions('@session:', new AbortController().signal);
            expect(sessions.flatMap(({ structuredInput }) => structuredInput && 'ref' in structuredInput ? [structuredInput.ref] : []))
                .toEqual(['session:invited-bot']);
            const people = await composer().autocompleteSuggestions('@', new AbortController().signal);
            expect(people.filter(row => row.kind === 'accountMention').map(row => row.key)).toEqual([ALICE.accountId]);
            expect(readParticipants).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
            store.setState(previous, true);
        }
    });

    it.each([accountLifetime.scope.accountId, ALICE.accountId])('omits the viewer from the ordinary picker with owner %s', async (ownerAccountId) => {
        readParticipants.mockResolvedValue({ kind: 'succeeded', value: DiscussionParticipantsListResponseV1Schema.parse({
            discussionId: 'discussion-1', ownerAccountId, access: 'edit', participants: [],
            grants: [{ principal: { kind: 'account', accountId: ALICE.accountId }, accessLevel: 'edit',
                createdByAccountId: accountLifetime.scope.accountId, createdAt: 1,
                display: { name: ALICE.profile.name, username: ALICE.profile.username } },
                ...(ownerAccountId !== accountLifetime.scope.accountId ? [{
                    principal: { kind: 'account', accountId: accountLifetime.scope.accountId }, accessLevel: 'edit',
                    createdByAccountId: ownerAccountId, createdAt: 1, display: { name: null },
                }] : [])],
        }) });
        await render(<Harness />);
        const rows = await composer().autocompleteSuggestions('@', new AbortController().signal);
        expect(rows.filter(row => row.kind === 'accountMention').map(row => row.key)).toEqual([ALICE.accountId]);
    });

    it.each(['retired', 'aborted'] as const)('does not publish a roster that arrives after the query is %s', async (reason) => {
        const value = DiscussionParticipantsListResponseV1Schema.parse({
            discussionId: 'discussion-1', ownerAccountId: ALICE.accountId, access: 'edit', grants: [],
            participants: [{ participant: { kind: 'session', sessionId: 'late-session' },
                answerPolicy: 'when_addressed', createdAt: 1 }],
        });
        const pending = createDeferred<{ kind: 'succeeded'; value: typeof value }>();
        readParticipants.mockReturnValueOnce(pending.promise);
        let current = true;
        await render(<Harness lifetime={{ ...accountLifetime, isCurrent: () => current }} />);
        const query = new AbortController();
        const suggestions = composer().autocompleteSuggestions('@session:', query.signal);
        if (reason === 'retired') current = false;
        else query.abort();
        pending.resolve({ kind: 'succeeded', value });
        expect(await suggestions).toEqual([]);
    });

    it('offers Retry when the people search fails, and retrying searches again', async () => {
        const { resolveComposerSuggestionKind } = await import('@/components/autocomplete/composerSuggestionKinds');
        readParticipants.mockRejectedValueOnce(new Error('offline'));
        await render(<Harness />);
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
        expect(readParticipants).toHaveBeenCalledTimes(2);
    });

    it('keeps the last picker row for "Type more to narrow" when the authorized roster has more matches', async () => {
        readParticipants.mockResolvedValueOnce({ kind: 'succeeded', value: {
            discussionId: 'discussion-1', ownerAccountId: 'account-0', access: 'edit',
            grants: Array.from({ length: 12 }, (_, index) => ({ principal: { kind: 'account', accountId: `account-${index}` }, accessLevel: 'edit', createdByAccountId: 'viewer-b', createdAt: 0, display: { name: `Alice ${index}` } })),
            participants: [],
        } });
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
        const onSend = vi.fn();
        const token = formatInlineReferenceTokenV1({ label: 'bob', ref: 'account:account-bob' });
        await render(<Harness initial={{ text: `Hi ${token}`, mentions: [
            { kind: 'happier.account', ref: 'account:account-bob', tokenText: token, start: 3, end: 3 + token.length },
        ] }} onSend={onSend} />);

        await act(async () => composer().onSend?.({ inputTextOverride: 'Hi @bob2' }));

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
