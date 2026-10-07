import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { changeTextTestInstance, renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import { AgentInput } from '@/components/sessions/agentInput';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';
import type { ComposerStructuredInputMention } from '@/components/sessions/agentInput/structuredInputMentions';

import { SessionDiscussionComposer, type SessionDiscussionComposerValue } from './SessionDiscussionComposer';

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
    extraActionChips?: readonly unknown[];
    sessionId?: string;
}>;

installAgentInputCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => (key === 'session.collaboration.discussion.messagePlaceholder' ? 'Write a message…' : key) });
    },
});
vi.mock('expo-image', () => ({ Image: (props: Record<string, unknown>) => React.createElement('Image', props, null) }));

const mounted = vi.hoisted(() => ({ screen: null as null | { root: { findByType: (type: unknown) => { props: Record<string, unknown> } } } }));
const listMentionCandidates = vi.hoisted(() => vi.fn());
const reportTyping = vi.hoisted(() => vi.fn());
const stopTyping = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/session/sessionDiscussionActions', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/api/session/sessionDiscussionActions')>()),
    listSessionDiscussionMentionCandidates: listMentionCandidates,
}));

vi.mock('@/sync/domains/session/humanPresence/sessionHumanPresenceRuntime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/session/humanPresence/sessionHumanPresenceRuntime')>()),
    reportSessionDiscussionTypingEdit: reportTyping,
    stopSessionDiscussionTyping: stopTyping,
}));

const ALICE = {
    accountId: 'account-alice',
    profile: { firstName: 'Alice', lastName: 'Ng', username: 'alice', avatarUrl: null },
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
    initial?: SessionDiscussionComposerValue;
    disabled?: boolean;
    onSend?: (content: unknown) => void;
    onValue?: (value: SessionDiscussionComposerValue) => void;
}>): React.ReactElement {
    const [value, setValue] = React.useState<SessionDiscussionComposerValue>(props.initial ?? { text: '', mentions: [] });
    return (
        <SessionDiscussionComposer
            scope={{ serverId: 'server-b', accountId: 'viewer-b' }}
            address={{ serverId: 'server-b', sessionId: 'session-shared-id' }}
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

describe('SessionDiscussionComposer (the one composer with the discussion adapter)', () => {
    beforeEach(() => {
        mounted.screen = null;
        listMentionCandidates.mockReset();
        listMentionCandidates.mockResolvedValue({ candidates: [ALICE], nextCursor: null });
        reportTyping.mockReset();
        stopTyping.mockReset();
    });

    it('is the one composer offering Account mentions only, with no agent chip or agent history', async () => {
        await render(<Harness />);

        expect(composer().autocompleteKinds).toEqual(['accountMention']);
        expect(composer().engineControls).toBe('none');
        expect(composer().voiceAffordance).toBe('none');
        expect(composer().messageHistory).toBe('none');
        expect(composer().extraActionChips ?? []).toEqual([]);
        expect(composer().sessionId).toBeUndefined();
        // An empty draft stays editable; Send's emptiness is the composer's own decision.
        expect(composer().disabled).toBe(false);
        expect(composer().inputAccessibilityLabel).toBeTruthy();
        expect(composer().inputAccessibilityLabel).toBe(composer().placeholder);
        expect(typeof composer().onSend).toBe('function');
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
        expect(listMentionCandidates).toHaveBeenCalledWith(expect.objectContaining({ query: 'Ali' }));
        expect(screen.getTextContent()).toContain('Alice Ng');
        await act(async () => {
            composerInput(screen).props.onKeyPress?.({ nativeEvent: { key: 'Enter' }, preventDefault: () => undefined });
        });
        await settle();
        expect(composerInput(screen).props.value).toBe('@Alice Ng ');

        await act(async () => {
            changeTextTestInstance(composerInput(screen), '@Alice Ng can you look?');
        });
        await act(async () => {
            await screen.root.findAll((node) => node.props.testID === 'new-session-composer-send' && typeof node.props.onPress === 'function')[0]!.props.onPress();
        });

        expect(onSend).toHaveBeenCalledWith({
            v: 1,
            parts: [
                { t: 'mention', accountId: 'account-alice' },
                { t: 'text', text: ' can you look?' },
            ],
        });
    });

    it('offers Retry when the people search fails, and retrying searches again', async () => {
        const { resolveComposerSuggestionKind } = await import('@/components/autocomplete/composerSuggestionKinds');
        listMentionCandidates.mockRejectedValueOnce(new Error('offline'));
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
        expect(listMentionCandidates).toHaveBeenCalledTimes(2);
    });

    it('asks the discussion for one row fewer than fit, keeping the last for "Type more to narrow"', async () => {
        listMentionCandidates.mockResolvedValueOnce({ candidates: [ALICE], nextCursor: 'cursor-2' });
        await render(<Harness />);

        const rows = await composer().autocompleteSuggestions('@a', new AbortController().signal);

        expect(listMentionCandidates).toHaveBeenCalledWith(expect.objectContaining({ limit: 11 }));
        expect(rows.map((row) => row.label)).toEqual(['Alice Ng', t('agentInput.suggestionTypeMoreToNarrow')]);
    });

    it('restores a drafted mention into the composer bound to its visible token', async () => {
        await render(<Harness initial={{ text: 'Hi @bob', mentions: [{ start: 3, end: 7, accountId: 'account-bob' }] }} />);

        expect(composer().value).toBe('Hi @bob');
        expect(composer().structuredInputMentions).toEqual([
            { kind: 'happier.account', ref: 'account:account-bob', tokenText: '@bob', start: 3, end: 7 },
        ]);
    });

    it('reports discussion typing while writing and stops it on blur or when the composer is locked', async () => {
        const screen = await render(<Harness />);
        const target = { serverId: 'server-b', sessionId: 'session-shared-id', discussionId: 'discussion-1' };

        await act(async () => {
            composer().onChangeText('Ready');
        });
        expect(reportTyping).toHaveBeenLastCalledWith(target, true);

        await act(async () => {
            composer().onComposerFocusChange?.(false);
        });
        expect(stopTyping).toHaveBeenCalledWith(target);

        stopTyping.mockClear();
        await screen.update(<Harness disabled />);
        expect(composer().disabled).toBe(true);
        expect(stopTyping).toHaveBeenCalledWith(target);
    });
});
