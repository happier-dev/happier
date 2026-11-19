/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';
import { createComposerTextStore } from './composerTextStore';
import type { ComposerStructuredInputMention } from './structuredInputMentions';
import { projectAgentInputAttachmentRowItems, type AgentInputAttachmentsRowItem } from './agentInputContracts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Resolve the browser platform input exactly as Metro does; all editor logic stays real.
vi.mock('@/components/ui/forms/MultiTextInput', async () => import('@/components/ui/forms/MultiTextInput.web'));
installAgentInputCommonModuleMocks({ reactNative: async () => vi.importActual('react-native-web') });
// Reanimated is a platform boundary; its renderer-test host strings cannot take DOM styles.
vi.doMock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const mock = createReanimatedModuleMock();
    const rn = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    const hosts = { View: rn.View, ScrollView: rn.ScrollView, Text: rn.Text };
    return { ...mock, ...hosts, default: { ...mock.default, ...hosts } };
});
const { installSessionPaneRuntimeTestHarness } = await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const runtime = installSessionPaneRuntimeTestHarness();
const { AgentInput } = await import('./AgentInput');
const { MultiTextInput } = await import('@/components/ui/forms/MultiTextInput.web');
const mapping = await import('@/components/ui/forms/composerEditor/composerTextDocMapping');
const mentionsOwner = await import('./structuredInputMentions');
const chipRowReach = await import('./definitions/agentInputChipRowReach');
const detection = await import('@/components/autocomplete/findActiveWord');
const recent = await import('@/components/sessions/composer/composerRecentReferences');
const chips = await import('@/components/ui/forms/composerEditor/ComposerChipView.web');
const drafts = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { useDraft } = await import('@/hooks/session/useDraft');
const { useSessionAgentInputComposerPersistence } = await import('@/hooks/session/useSessionAgentInputComposerPersistence');
const { SessionComposerAgentInput } = await import('@/components/sessions/composer/SessionComposerAgentInput');
const { useAttachmentDraftManager } = await import('@/components/sessions/attachments/useAttachmentDraftManager');
const { t } = await import('@/text');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { storage } = await import('@/sync/domains/state/storage');
const { DecorationSet } = await import('@tiptap/pm/view');
const { patchAgentInputLocalUiState } = await import('@/sync/domains/input/draftValues/agentInputLocalUiStateStore');
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    container?.remove(); container = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Session composer keystroke work', () => {
    it('binds an image pasted mid-text while preserving the shifted Session reference', async () => {
        Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(25, 35, 0, 18) });
        vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
        vi.stubGlobal('URL', class extends URL {
            static createObjectURL() { return 'blob:pasted-image'; }
            static revokeObjectURL() {}
        });
        const tokenText = formatInlineReferenceTokenV1({ ref: 'session:reference', label: 'Reference' });
        const text = `Before ${tokenText} after`;
        const references: ComposerStructuredInputMention[] = [{ kind: 'happier.session', ref: 'session:reference',
            tokenText, start: 7, end: 7 + tokenText.length }];
        const store = createComposerTextStore(text);
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        drafts.writeExistingSessionDraft({ scope: lifetime.scope, sessionId: 's1', patch: { text, mentions: references }, materializationIntent: 'userEdit' });
        patchAgentInputLocalUiState(lifetime.scope, { kind: 'session', sessionId: 's1' }, {
            selection: { start: 7, end: 7 }, textLength: text.length,
        });
        function SessionHost() {
            const persistence = useSessionAgentInputComposerPersistence({ sessionId: 's1', accountLifetime: lifetime, textStore: store });
            const draft = useDraft('s1', store, { accountLifetime: lifetime, session: storage.getState().sessions.s1, active: true });
            const attachments = useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024 });
            return <SessionComposerAgentInput textStore={store} pendingText={null} sessionId="s1" onChangeText={draft.setDraftValue}
                onSend={() => {}} placeholder="Message" autocompleteKinds={[]} autocompleteSuggestions={async () => []}
                inputPersistence={persistence.inputPersistence} structuredInputPersistence={persistence.structuredInputPersistence}
                onStructuredInputMentionsChange={persistence.structuredInputPersistence.onMentionsChange}
                onAttachmentsAdded={attachments.addWebFiles}
                attachmentRowItems={projectAgentInputAttachmentRowItems({ transferAttachments: attachments.agentInputAttachments })} />;
        }
        container = document.createElement('div'); document.body.append(container); root = createRoot(container);
        await act(async () => { root!.render(<runtime.Wrapper><SessionHost /></runtime.Wrapper>); });
        const editor = container.querySelector<HTMLElement>('[data-happier-text-input]')!;
        await act(async () => { editor.focus(); });
        const image = new File(['image'], 'pasted.png', { type: 'image/png' });
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: { files: [image], types: ['Files'],
            items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }], getData: () => '' } });
        await act(async () => { editor.dispatchEvent(event); });
        expect(Array.from(editor.querySelectorAll('[data-happier-ref-label]'), node => node.textContent)).toEqual([t('composerReferences.imageNumber', { number: 1 }), 'Reference']);
        const saved = drafts.getSessionComposerDraftSnapshot(lifetime.scope, { kind: 'session', sessionId: 's1' });
        expect(saved?.composer.mentions.value).toHaveLength(2);
        expect(store.getPrompt()).toContain(' after');
    });

    it.each(['after', 'before'] as const)('keeps unchanged chips mounted and bounds projection work when typing %s the chips', async position => {
        Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(25, 35, 0, 18) });
        vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
        let text = '';
        const references: ComposerStructuredInputMention[] = [];
        for (let index = 0; index < 11; index++) {
            const ref = `session:reference-${index}`;
            const tokenText = formatInlineReferenceTokenV1({ ref, label: `Reference ${index}` });
            references.push({ kind: 'happier.session', ref, tokenText, start: text.length, end: text.length + tokenText.length });
            text += `${tokenText} `;
        }
        text += 'Explain this';
        const store = createComposerTextStore(text);
        const counts = { hostRenders: 0, commits: 0 };
        const suggestions = vi.fn(async () => []);
        const onSend = () => {};
        const kinds: React.ComponentProps<typeof AgentInput>['autocompleteKinds'] = ['session'];
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        drafts.writeExistingSessionDraft({ scope: lifetime.scope, sessionId: 's1', patch: { text, mentions: references }, materializationIntent: 'userEdit' });
        const offset = position === 'before' ? 0 : text.length;
        patchAgentInputLocalUiState(lifetime.scope, { kind: 'session', sessionId: 's1' }, {
            selection: { start: offset, end: offset }, textLength: text.length,
        });
        function SessionHost() {
            counts.hostRenders++;
            const persistence = useSessionAgentInputComposerPersistence({ sessionId: 's1', accountLifetime: lifetime, textStore: store });
            const draft = useDraft('s1', store, { accountLifetime: lifetime, session: storage.getState().sessions.s1, active: true });
            return <React.Profiler id="AgentInput" onRender={() => counts.commits++}>
                <SessionComposerAgentInput textStore={store} pendingText={null} sessionId="s1" onChangeText={draft.setDraftValue}
                    onSend={onSend} placeholder="Message" autocompleteKinds={kinds} autocompleteSuggestions={suggestions}
                    inputPersistence={persistence.inputPersistence} structuredInputPersistence={persistence.structuredInputPersistence}
                    onStructuredInputMentionsChange={persistence.structuredInputPersistence.onMentionsChange} />
            </React.Profiler>;
        }
        container = document.createElement('div'); document.body.append(container); root = createRoot(container);
        await act(async () => { root!.render(<runtime.Wrapper><SessionHost /></runtime.Wrapper>); });
        const editor = container.querySelector<HTMLElement>('[data-happier-text-input]')!;
        expect(editor).toBeTruthy();
        expect(editor.querySelectorAll('[data-composer-chip]')).toHaveLength(11);
        await act(async () => {
            editor.focus();
        });
        const typeKey = async (key: string) => {
            await act(async () => {
                editor.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
                // jsdom has no default text-edit action; emulate that browser boundary only.
                const selection = window.getSelection()!;
                const typed = document.createTextNode(key);
                selection.getRangeAt(0).insertNode(typed);
                selection.collapse(typed, 1);
                editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: key }));
                await new Promise<void>(resolve => queueMicrotask(resolve));
            });
        };
        // The first key after focus marks the text as edited (one render); the contract is the steady-state key.
        await typeKey('w');
        const nodes = [...editor.querySelectorAll('[data-composer-chip]')];
        const map = vi.spyOn(mapping, 'mapComposerDoc');
        const rebuild = vi.spyOn(mapping, 'composerTextToDoc');
        const reconcile = vi.spyOn(mentionsOwner, 'reconcileStructuredInputMentionsWithTextChange');
        const detect = vi.spyOn(detection, 'findActiveWord');
        const recentBuild = vi.spyOn(recent, 'buildComposerRecentReferenceSuggestions');
        const chipRender = vi.spyOn(chips.ComposerChipView, 'type');
        // Instrument the real React render functions without replacing their implementation.
        type RenderProbe = { render: (...args: unknown[]) => React.ReactNode };
        const agentRender = vi.spyOn((AgentInput as unknown as { type: RenderProbe }).type, 'render');
        const inputRender = vi.spyOn(MultiTextInput as unknown as RenderProbe, 'render');
        const draftWrites = vi.spyOn(drafts, 'writeExistingSessionDraft');
        const draftFlushes = vi.spyOn(drafts, 'flushSessionDraft');
        const decorations = vi.spyOn(DecorationSet, 'create');
        const before = { ...counts };
        await typeKey('x');
        const work = { hostRenders: counts.hostRenders - before.hostRenders, commits: counts.commits - before.commits,
            maps: map.mock.calls.length, rebuilds: rebuild.mock.calls.length, reconciles: reconcile.mock.calls.length,
            detections: detect.mock.calls.length, recent: recentBuild.mock.calls.length, suggestions: suggestions.mock.calls.length,
            chipRenders: chipRender.mock.calls.length, agentRenders: agentRender.mock.calls.length, inputRenders: inputRender.mock.calls.length,
            draftWrites: draftWrites.mock.calls.length, draftFlushes: draftFlushes.mock.calls.length,
            decorations: decorations.mock.calls.length };
        console.info('composer-keystroke-work', position, JSON.stringify(work));
        expect(store.getPrompt()).toBe(position === 'before' ? `wx${text}` : `${text}wx`);
        const currentNodes = [...editor.querySelectorAll('[data-composer-chip]')];
        expect(currentNodes).toHaveLength(nodes.length);
        currentNodes.forEach((node, index) => expect(node).toBe(nodes[index]));
        expect(work.hostRenders).toBe(0);
        expect(work.chipRenders).toBe(0);
        expect(work.recent).toBe(0);
        expect(work.suggestions).toBe(0);
        expect(work.draftWrites).toBeLessThanOrEqual(position === 'before' ? 2 : 1);
        expect(work.draftFlushes).toBe(0);
        expect(work.reconciles).toBe(1);
        expect(work.detections).toBe(1);
        expect(work.rebuilds).toBe(0);
        expect(work.maps).toBeLessThanOrEqual(2);
        expect(work.commits).toBeLessThanOrEqual(2);
    });
    it('re-renders the text leaf and not the composer chrome on an ordinary key', async () => {
        Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(25, 35, 0, 18) });
        vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
        const store = createComposerTextStore('Explain this');
        const chipRail = vi.spyOn(chipRowReach, 'AgentInputChipRowReach');
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        function SessionHost() {
            const persistence = useSessionAgentInputComposerPersistence({ sessionId: 's1', accountLifetime: lifetime, textStore: store });
            const draft = useDraft('s1', store, { accountLifetime: lifetime, session: storage.getState().sessions.s1, active: true });
            return <SessionComposerAgentInput textStore={store} pendingText={null} sessionId="s1" onChangeText={draft.setDraftValue}
                onSend={() => {}} placeholder="Message" autocompleteKinds={[]} autocompleteSuggestions={async () => []}
                inputPersistence={persistence.inputPersistence} structuredInputPersistence={persistence.structuredInputPersistence}
                onStructuredInputMentionsChange={persistence.structuredInputPersistence.onMentionsChange} />;
        }
        container = document.createElement('div'); document.body.append(container); root = createRoot(container);
        await act(async () => { root!.render(<runtime.Wrapper><SessionHost /></runtime.Wrapper>); });
        const editor = container.querySelector<HTMLElement>('[data-happier-text-input]')!;
        await act(async () => { editor.focus(); });
        const typeKey = async (key: string) => {
            await act(async () => {
                editor.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
                const selection = window.getSelection()!;
                const typed = document.createTextNode(key);
                selection.getRangeAt(0).insertNode(typed);
                selection.collapse(typed, 1);
                editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: key }));
                await new Promise<void>(resolve => queueMicrotask(resolve));
            });
        };
        // The first key after focus marks the text as edited (one render); the contract is the steady-state key.
        await typeKey('w');
        type RenderProbe = { render: (...args: unknown[]) => React.ReactNode };
        const inputRender = vi.spyOn(MultiTextInput as unknown as RenderProbe, 'render');
        // The chrome's chip rail is part of the footer; it must have rendered at mount for the probe to mean anything.
        expect(chipRail.mock.calls.length).toBeGreaterThan(0);
        chipRail.mockClear();
        await typeKey('x');
        expect(store.getPrompt()).toContain('wx');
        expect(inputRender.mock.calls.length).toBeGreaterThan(0);
        expect(chipRail.mock.calls.length).toBe(0);
    });
    it('updates plugin attachment badges without rendering the text and selection owner (QB-40)', async () => {
        Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(25, 35, 0, 18) });
        vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
        const store = createComposerTextStore('Explain this');
        const lifetime = captureActiveServerAccountScopeLifetime()!;
        // A plugin attachment (a Triage entry) reaches the composer as a host badge with no tray identity.
        const badge = (key: string, label: string): AgentInputAttachmentsRowItem => ({ kind: 'badge', key, label });
        let setAttachments!: (items: readonly AgentInputAttachmentsRowItem[]) => void;
        // A real host keeps these stable across its renders; only the attachment row changes below.
        const kinds: React.ComponentProps<typeof AgentInput>['autocompleteKinds'] = [];
        const suggestions = async () => [];
        const onSend = () => {};
        function SessionHost() {
            const [items, setItems] = React.useState<readonly AgentInputAttachmentsRowItem[]>([]);
            setAttachments = setItems;
            const persistence = useSessionAgentInputComposerPersistence({ sessionId: 's1', accountLifetime: lifetime, textStore: store });
            const draft = useDraft('s1', store, { accountLifetime: lifetime, session: storage.getState().sessions.s1, active: true });
            return <SessionComposerAgentInput textStore={store} pendingText={null} sessionId="s1" onChangeText={draft.setDraftValue}
                onSend={onSend} placeholder="Message" autocompleteKinds={kinds} autocompleteSuggestions={suggestions}
                inputPersistence={persistence.inputPersistence} structuredInputPersistence={persistence.structuredInputPersistence}
                onStructuredInputMentionsChange={persistence.structuredInputPersistence.onMentionsChange}
                attachmentRowItems={items} />;
        }
        container = document.createElement('div'); document.body.append(container); root = createRoot(container);
        await act(async () => { root!.render(<runtime.Wrapper><SessionHost /></runtime.Wrapper>); });
        const editor = container.querySelector<HTMLElement>('[data-happier-text-input]')!;
        await act(async () => { editor.focus(); });
        type RenderProbe = { render: (...args: unknown[]) => React.ReactNode };
        const agentRender = vi.spyOn((AgentInput as unknown as { type: RenderProbe }).type, 'render');
        const inputRender = vi.spyOn(MultiTextInput as unknown as RenderProbe, 'render');
        // Zero, one, then many: each is an attachment-only change to the composer.
        for (const items of [[badge('triage:1', 'Fix the login loop')], [badge('triage:1', 'Fix the login loop'), badge('triage:2', 'Crash on save')], []]) {
            await act(async () => { setAttachments(items); });
            expect(container.textContent).toContain(items.length === 0 ? 'Explain this' : items.at(-1)!.label);
        }
        // The chrome takes the new row; the text and selection owner does not render for it.
        expect(agentRender.mock.calls.length).toBeGreaterThan(0);
        expect(inputRender.mock.calls.length).toBe(0);
        expect(store.getPrompt()).toBe('Explain this');
    });
});
