/**
 * @vitest-environment jsdom
 *
 * The composer, end to end, driven by a real pointer press.
 *
 * A completely dead `@` shipped with 242 green tests because **every** suite in
 * this corridor mocked the layer directly beneath the one it claimed to verify:
 * the ten `AgentInput.*` suites mock `useActiveSuggestions`, the two that would
 * otherwise render a picker mock `@/components/ui/commandMenu` to `() => null`,
 * `CommandMenu.test.tsx` and its native twin mock `CommandMenuSurface` away, and
 * every `components/autocomplete/**` suite stops at `getSuggestions`. Nothing
 * crossed more than one seam, so "the dispatcher returned rows" and "the user can
 * pick one" were indistinguishable — and both P0s lived in exactly that gap.
 *
 * This suite closes it. It mounts the real `AgentInput` with the real
 * `CommandMenu`, the real `CommandMenuSurface`, the real `SelectionList` rows and
 * the real `getSuggestions` registry, and presses a row with real DOM mouse
 * events. It asserts the only outcome the user cares about — **the composer text
 * changed** — never that a handler was called.
 *
 * Three harness decisions are load-bearing:
 *
 * 1. `react-native` resolves to the **real** `react-native-web`, so props reach
 *    the DOM through its actual whitelist. A hand-rolled `View` stub that spreads
 *    every prop onto a `div` will happily certify a handler the browser can never
 *    call — that is how `CommandMenuSurface.webFocus.test.tsx` first shipped green
 *    over an inert fix (`onMouseDownCapture` is dropped by react-native-web;
 *    `onMouseDown` is not).
 * 2. The shared Vitest config has **no platform-extension resolution**, so
 *    `@/components/ui/forms/MultiTextInput` would resolve to the *native* module
 *    inside a web-platform test. `setTextAndSelection` — the final hop of the whole
 *    commit path — has a different implementation per platform, so the web module
 *    is aliased in explicitly. A press test running the native text input would
 *    leave the web commit unpinned. (`useTextInputCaretRect` keeps its default
 *    `.native` resolution here; it only chooses the popover *anchor*, which is not
 *    this suite's contract.)
 * 3. `pressRow` performs the two steps jsdom omits. react-native-web invokes
 *    `Pressable`'s `onPress` from the native **`click`** event, not from responder
 *    release ("Only when the browser produces a `click` event is `onPress`
 *    invoked", `usePressEvents/PressResponder.js`) — and a browser produces no
 *    click when the pressed element disappears mid-gesture. jsdom also does not
 *    implement the focus-on-mousedown default action. Both are modelled, so the
 *    reported bug ("clicking a suggestion does nothing; you have to press Tab") is
 *    reproduced as a mechanism instead of asserted as a prop: an uncancelled
 *    mousedown blurs the composer, `AgentInput` drops the query, the row unmounts,
 *    and no click is ever delivered.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSuggestions } from '@/components/autocomplete/suggestions';
import type { FileItem } from '@/sync/domains/input/suggestionFile';

// Static, not lazy: Vitest hoists every `vi.mock` factory below above the imports,
// so the mocks still apply — while importing this graph inside the first test
// charged its ~30 s transform to that test's own timeout budget.
import { AgentInput } from './AgentInput';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => await vi.importActual('react-native-web'));

// The web platform's own text input — see the header. Not a behavioural stub:
// this is the module Metro resolves for `platform: 'web'`.
vi.mock('@/components/ui/forms/MultiTextInput', async () => (
    await vi.importActual('@/components/ui/forms/MultiTextInput.web')
));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

// OS boundary. Mocked at the platform package rather than at our own
// `theme/haptics` wrapper so the app's own call path stays real.
vi.mock('expo-haptics', () => ({
    impactAsync: async () => {},
    notificationAsync: async () => {},
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

/** True system boundaries: the daemon file search and command search. */
const searchFilesMock = vi.hoisted(() => vi.fn(
    async (_scope: unknown, _query: string, _options?: Readonly<{ limit?: number }>): Promise<FileItem[]> => [],
));
const searchCommandsMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));

vi.mock('@/sync/domains/input/suggestionFile', () => ({ searchFiles: searchFilesMock }));
vi.mock('@/sync/domains/input/suggestionCommands', () => ({ searchCommands: searchCommandsMock }));

const SESSION_ID = 'session-a';
const WORKSPACE = { machineId: 'machine-a', path: '/repo', serverId: 'server-a' } as const;
const PROMPT_ARTIFACT_ID = 'artifact-prompt-1';
const PROMPT_TEMPLATE_TEXT = 'Write a really detailed plan before touching any code.';

const storageStateMock = vi.hoisted(() => ({
    sessions: {} as Record<string, unknown>,
    artifacts: {} as Record<string, { body?: string }>,
    machines: {} as Record<string, unknown>,
    updateArtifact: vi.fn(),
    applySessions: vi.fn(),
    getProjectForSession: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const [{ createPartialStorageModuleMock }, { settingsDefaults }] = await Promise.all([
        import('@/dev/testkit/mocks/storage'),
        import('@/sync/domains/settings/settings'),
    ]);
    return createPartialStorageModuleMock(importOriginal as <T>() => Promise<T>, {
        storage: { getState: () => storageStateMock },
        useSettings: () => settingsDefaults,
        useSetting: (key: string) => (settingsDefaults as Record<string, unknown>)[key] ?? null,
        useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
        useSessionMessagesById: () => ({}),
        useSessionMessagesVersion: () => 0,
        useSessionMessagesReducerState: () => null,
        useSessionProjectScmSnapshot: () => null,
    });
});

/** `SessionView.tsx`'s eligible-kind subset for the session composer, verbatim. */
const SESSION_COMPOSER_SUGGESTION_KINDS = ['file', 'vendorPlugin', 'skill', 'slashCommand'] as const;

function file(fullPath: string): FileItem {
    const fileName = fullPath.split('/').pop() ?? fullPath;
    return {
        fileName,
        filePath: fullPath.slice(0, fullPath.length - fileName.length),
        fullPath,
        fileType: 'file',
    } as FileItem;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    searchFilesMock.mockReset();
    searchFilesMock.mockResolvedValue([]);
    searchCommandsMock.mockReset();
    searchCommandsMock.mockResolvedValue([]);
    storageStateMock.updateArtifact.mockReset();
    storageStateMock.machines = {};
    storageStateMock.artifacts = {
        [PROMPT_ARTIFACT_ID]: {
            body: JSON.stringify({
                v: 1,
                markdown: PROMPT_TEMPLATE_TEXT,
                createdAtMs: 0,
                updatedAtMs: 0,
            }),
        },
    };
    // Both catalog snapshots are present, so the catalog-backed kinds resolve from
    // session metadata and never reach the daemon RPC.
    storageStateMock.sessions = {
        [SESSION_ID]: {
            id: SESSION_ID,
            active: true,
            metadata: {
                path: '/repo',
                sessionVendorPluginCatalogV1: { vendorPlugins: [] },
                sessionSkillCatalogV1: { skills: [] },
            },
        },
    };
});

afterEach(async () => {
    await act(async () => {
        root.unmount();
    });
    container.remove();
});

type MountedComposer = Readonly<{
    /** The uncontrolled `<textarea>` the user sees and sends. */
    text: () => string;
    textarea: HTMLTextAreaElement;
}>;

/** Mounts the session composer wired exactly as `SessionView` wires it. */
async function renderSessionComposer(): Promise<MountedComposer> {
    function Host() {
        const [value, setValue] = React.useState('');
        // `SessionView.handleAutocompleteSuggestions`, verbatim.
        const handler = React.useCallback(
            (query: string, signal: AbortSignal) => getSuggestions(SESSION_ID, query, {
                kinds: SESSION_COMPOSER_SUGGESTION_KINDS,
                workspace: WORKSPACE,
                signal,
            }),
            [],
        );
        return (
            <AgentInput
                value={value}
                onChangeText={setValue}
                placeholder="Message"
                onSend={() => {}}
                autocompleteKinds={SESSION_COMPOSER_SUGGESTION_KINDS}
                autocompleteSuggestions={handler}
                sessionId={SESSION_ID}
                metadata={null}
                disabled={false}
                showAbortButton={false}
            />
        );
    }

    await act(async () => {
        root.render(<Host />);
    });

    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('composer textarea did not mount');
    return { text: () => textarea.value, textarea };
}

/** Types into the composer the way a keystroke reaches React on web. */
async function typeIntoComposer(composer: MountedComposer, text: string) {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
        composer.textarea.focus();
        valueSetter?.call(composer.textarea, text);
        composer.textarea.setSelectionRange(text.length, text.length);
        composer.textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {});
}

function findMenuRow(optionId: string): HTMLElement | null {
    // The popover portals out of the render container, so search the document.
    return document.querySelector<HTMLElement>(
        `[data-testid="agent-input-command-menu:list:command-menu-root:option:${optionId}"]`,
    );
}

type PressOutcome = Readonly<{
    /** The surface cancelled the pointer-down default, so focus stayed put. */
    pointerDownCancelled: boolean;
    /** The row was still mounted when the gesture ended, so a click was delivered. */
    clickDelivered: boolean;
}>;

/**
 * A real pointer press, including the two steps jsdom leaves out (see the header).
 */
async function pressRow(composer: MountedComposer, optionId: string): Promise<PressOutcome> {
    const row = findMenuRow(optionId);
    if (!row) throw new Error(`suggestion row "${optionId}" is not rendered`);

    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
        row.dispatchEvent(down);
        if (!down.defaultPrevented) {
            // The browser's default action for a pointer press: focus moves to what
            // was pressed, which blurs the composer.
            composer.textarea.blur();
        }
    });

    const survivor = findMenuRow(optionId);
    if (survivor) {
        await act(async () => {
            survivor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
            survivor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        });
    }
    await act(async () => {});

    return { pointerDownCancelled: down.defaultPrevented, clickDelivered: survivor !== null };
}

describe('AgentInput — a pointer press on a suggestion rewrites the composer', () => {
    it('commits a file suggestion without the press stealing composer focus', async () => {
        searchFilesMock.mockResolvedValue([file('README.md'), file('docs/README.md')]);

        const composer = await renderSessionComposer();
        await typeIntoComposer(composer, '@REA');

        expect(findMenuRow('file-README.md')).not.toBeNull();

        const press = await pressRow(composer, 'file-README.md');

        expect(press.pointerDownCancelled).toBe(true);
        expect(press.clickDelivered).toBe(true);
        expect(document.activeElement).toBe(composer.textarea);
        expect(composer.text()).toBe('@README.md ');
        // The caret lands just past the inserted token and its trailing space, so the
        // next keystroke continues the message. Nothing pinned this: replacing the
        // host's `result.cursorPosition` with `0` — which would drop every subsequent
        // keystroke at the start of the composer — left the whole corridor green.
        expect(composer.textarea.selectionStart).toBe('@README.md '.length);
        expect(composer.textarea.selectionEnd).toBe('@README.md '.length);
    });

    // The other half of the same contract. `CommandMenuSurface` cancels the
    // pointer-down default precisely BECAUSE losing composer focus drops the query
    // and unmounts the row — but nothing asserted that losing focus does close the
    // picker, so the gate could be deleted (which "fixes" the press bug) while
    // leaving a picker open over a composer that no longer has focus. Deleting
    // `isInputFocused` from `activeSuggestionQuery` left the whole corridor green.
    it('closes the picker when the composer loses focus', async () => {
        searchFilesMock.mockResolvedValue([file('README.md')]);

        const composer = await renderSessionComposer();
        await typeIntoComposer(composer, '@REA');

        expect(findMenuRow('file-README.md')).not.toBeNull();

        await act(async () => {
            composer.textarea.blur();
        });
        await act(async () => {});

        expect(findMenuRow('file-README.md')).toBeNull();
    });

    // The picker highlights the first row; a press must commit the row under the
    // pointer, not the highlighted one. `CommandMenu` resolves the pressed row's
    // index from its own item list and the host applies THAT index.
    it('commits the row that was pressed, not the highlighted one', async () => {
        searchFilesMock.mockResolvedValue([file('README.md'), file('docs/README.md')]);

        const composer = await renderSessionComposer();
        await typeIntoComposer(composer, '@REA');

        await pressRow(composer, 'file-docs/README.md');

        expect(composer.text()).toBe('@docs/README.md ');
    });

    // D-20: a prompt-template command replaces the ENTIRE input, through the kind's
    // own `applySelection`, not through token substitution. This is the second
    // reported P0 symptom ("selecting a prompt template does nothing") and it is a
    // different branch of `handleSuggestionSelect` from the file case above.
    it('expands a prompt-template slash command over the whole input', async () => {
        searchCommandsMock.mockResolvedValue([{
            command: 'detailed-plan',
            promptInvocation: {
                invocationId: 'inv-1',
                token: 'detailed-plan',
                targetArtifactId: PROMPT_ARTIFACT_ID,
                behavior: 'insert',
                allowArgs: false,
            },
        }]);

        const composer = await renderSessionComposer();
        await typeIntoComposer(composer, '/detai');

        const press = await pressRow(composer, 'cmd-detailed-plan');

        expect(press.clickDelivered).toBe(true);
        expect(composer.text()).toBe(PROMPT_TEMPLATE_TEXT);
    });
});
