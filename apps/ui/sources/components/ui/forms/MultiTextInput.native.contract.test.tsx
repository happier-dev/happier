import * as React from 'react';
import { View } from 'react-native';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { MultiTextInputHandle } from './MultiTextInput';
import { storage } from '@/sync/domains/state/storage';
const openUrl = vi.hoisted(() => vi.fn(async () => {}));

// The canonical Expo test boundary retains the compiled view's public props and source-offset events.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, { View: 'View', findNodeHandle: () => 42, Linking: { openURL: openUrl } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const initialStorageState = storage.getState();
afterEach(async () => {
    await standardCleanup();
    storage.setState(initialStorageState, true);
    openUrl.mockClear();
});

describe('MultiTextInput native composer boundary', () => {
    it.each(['native', 'imperative'] as const)('keeps a shifted reference in the real document owner after a %s edit', async entry => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const { createEphemeralComposerDocumentOwner } = await import('@/components/sessions/composer/composerDocumentOwner');
        const { composerReferencesFromStructuredMentions, composerStructuredMentionsFromReferences } = await import('@/components/sessions/composer/composerScopeAdapters');
        const { parseComposerStructuredInputMentionsForText } = await import('@/sync/domains/input/draftValues/sessionDraftValueTypes');
        const token = formatInlineReferenceTokenV1({ ref: 'file:src/a.ts', label: 'a.ts' });
        const mentions = composerStructuredMentionsFromReferences({ references: [
            { kind: 'happier.file', ref: 'file:src/a.ts', token, start: 0, end: token.length },
        ], existing: [] });
        const owner = createEphemeralComposerDocumentOwner({
            ref: { kind: 'session', sessionId: 'native-reference' },
            capabilities: { text: true, references: true, attachments: false, submit: false },
            initialDocument: { text: token, structuredInputMentions: mentions, composerAttachments: [] },
        });
        const ref = React.createRef<MultiTextInputHandle>();
        const references = composerReferencesFromStructuredMentions({ text: token, mentions })
            .map(reference => ({ ...reference, label: 'a.ts', binding: mentions[0] }));
        const screen = await renderScreen(<MultiTextInput ref={ref} value={token} references={references}
            onChangeText={text => owner.replaceDocument({ ...owner.read().document, text })}
            onReferencesChange={next => owner.replaceDocument({ ...owner.read().document,
                structuredInputMentions: parseComposerStructuredInputMentionsForText(next.flatMap(reference => (
                    reference.binding !== null && typeof reference.binding === 'object'
                        ? [{ ...reference.binding, tokenText: reference.token, start: reference.start, end: reference.end }]
                        : []
                )), ref.current!.getText()).mentions,
            })} />);
        const text = `Before ${token}`;
        const selection = { start: text.length, end: text.length };
        act(() => {
            if (entry === 'imperative') ref.current!.setTextAndSelection(text, selection);
            else screen.tree.findByType('HappierComposerInput').props.onComposerChange({ nativeEvent: {
                text, selection, eventCount: 1,
                references: [{ ref: 'file:src/a.ts', token, start: 7, end: text.length }],
            } });
        });
        const document = owner.read().document;
        expect(document.text).toBe(text);
        expect(composerReferencesFromStructuredMentions({ text, mentions: document.structuredInputMentions }))
            .toEqual([{ kind: 'happier.file', ref: 'file:src/a.ts', token, start: 7, end: text.length }]);
    });

    it.each([0, 24])('does not publish or resend unchanged chip bindings for twenty text edits after %i chips', async (chipCount) => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const references = Array.from({ length: chipCount }, (_, index) => {
            const identity = index % 12;
            const token = formatInlineReferenceTokenV1({ ref: `session:auth-${identity}`, label: `Auth ${identity}` });
            return { ref: `session:auth-${identity}`, token, start: 0, end: 0, kind: 'session', label: `Auth ${identity}`,
                binding: { occurrence: index } };
        });
        let text = '';
        for (const reference of references) {
            reference.start = text.length;
            text += reference.token + ' ';
            reference.end = text.length - 1;
        }
        const onReferencesChange = vi.fn();
        const onChangeText = vi.fn();
        const screen = await renderScreen(<MultiTextInput value={text} references={chipCount > 0 ? references : undefined}
            onChangeText={onChangeText} onReferencesChange={onReferencesChange} />);
        const nativeReferences = screen.tree.findByType('HappierComposerInput').props.references;
        let referencePropChanges = 0;
        for (let eventCount = 1; eventCount <= 20; eventCount++) {
            text += 'x';
            act(() => screen.tree.findByType('HappierComposerInput').props.onComposerChange({ nativeEvent: {
                text, selection: { start: text.length, end: text.length }, eventCount,
                references: references.map(({ ref, token, start, end }) => ({ ref, token, start, end })),
            } }));
            await screen.update(<MultiTextInput value={text} references={chipCount > 0 ? references : undefined}
                onChangeText={onChangeText} onReferencesChange={onReferencesChange} />);
            if (screen.tree.findByType('HappierComposerInput').props.references !== nativeReferences) referencePropChanges++;
        }
        expect(onChangeText).toHaveBeenCalledTimes(20);
        expect({ publications: onReferencesChange.mock.calls.length, referencePropChanges }).toEqual({ publications: 0, referencePropChanges: 0 });

        const shifted = references.map(reference => ({ ...reference, start: reference.start + 1, end: reference.end + 1 }));
        act(() => screen.tree.findByType('HappierComposerInput').props.onComposerChange({ nativeEvent: {
            text: `x${text}`, selection: { start: 1, end: 1 }, eventCount: 21,
            references: shifted.map(({ ref, token, start, end }) => ({ ref, token, start, end })),
        } }));
        if (chipCount > 0) {
            expect(onReferencesChange).toHaveBeenCalledOnce();
            expect(onReferencesChange).toHaveBeenLastCalledWith(shifted);
            for (let index = 0; index < shifted.length; index++) {
                expect(onReferencesChange.mock.calls[0][0][index].binding).toBe(references[index].binding);
            }
        } else expect(onReferencesChange).not.toHaveBeenCalled();
    });

    it('keeps imperative editing available with a generic native view ref in composed renders', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const ref = React.createRef<MultiTextInputHandle>();
        const onStateChange = vi.fn();
        const onChangeText = vi.fn();
        const focus = vi.fn();
        await renderScreen(<MultiTextInput ref={ref} value="hello"
            onChangeText={onChangeText} onStateChange={onStateChange} />, {
            // Composed screens supply generic OS view methods, not the Expo module's commands.
            createNodeMock: () => ({ focus }),
        });

        act(() => ref.current!.setSelection({ start: 1, end: 4 }));
        expect(onStateChange).toHaveBeenLastCalledWith({ text: 'hello', selection: { start: 1, end: 4 } });
        act(() => {
            ref.current!.setDropCaret(2);
            ref.current!.setDropCaret(null);
            ref.current!.setTextAndSelection('hello world', { start: 11, end: 11 });
            ref.current!.focus();
        });
        expect(ref.current!.getText()).toBe('hello world');
        expect(onChangeText).toHaveBeenLastCalledWith('hello world');
        expect(onStateChange).toHaveBeenLastCalledWith({ text: 'hello world', selection: { start: 11, end: 11 } });
        expect(focus).toHaveBeenCalledOnce();
        expect(await ref.current!.offsetAtPoint({ x: 10, y: 20 })).toBeNull();
    });

    it('delivers native folder sources and their source-text drop offset without changing text', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const dropped = vi.fn();
        const changed = vi.fn();
        const source = { kind: 'folder', name: 'Design', mimeType: 'inode/directory', directories: ['empty'], entries: [
            { relativePath: 'icons/a.svg', source: { kind: 'native', uri: 'file:///cache/a.svg', name: 'a.svg', sizeBytes: 3, mimeType: 'image/svg+xml' } },
        ] } as const;
        const screen = await renderScreen(<MultiTextInput value="Before after" onChangeText={changed} onAttachmentsDropped={dropped} />);
        const view = screen.tree.findByType('HappierComposerInput');
        expect(view.props.acceptsAttachmentDrops).toBe(true);
        await act(async () => view.props.onComposerAttachmentDrop({ nativeEvent: { sources: [source], offset: 7 } }));
        expect(dropped).toHaveBeenCalledWith({ sources: [source], offset: 7 });
        expect(changed).not.toHaveBeenCalled();
        await screen.update(<MultiTextInput value="Before after" editable={false} onChangeText={changed} onAttachmentsDropped={dropped} />);
        expect(screen.tree.findByType('HappierComposerInput').props.acceptsAttachmentDrops).toBe(false);
        await screen.update(<MultiTextInput value="Before after" attachmentDropScope="other-session" onChangeText={changed} onAttachmentsDropped={dropped} />);
        await act(async () => screen.tree.findByType('HappierComposerInput').props.onComposerAttachmentDrop({ nativeEvent: { sources: [source], offset: 7, scope: 'old-session' } }));
        expect(dropped).toHaveBeenCalledOnce();
    });
    it('opens a reference through its host binding and a decoration through the shared external URL owner', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const token = formatInlineReferenceTokenV1({ ref: 'session:auth', label: 'Auth' });
        const onOpen = vi.fn();
        const screen = await renderScreen(<MultiTextInput value={token} onChangeText={() => {}}
            references={[{ ref: 'session:auth', token, start: 0, end: token.length, label: 'Auth', kind: 'session', onOpen }]} />);
        const view = screen.tree.findByType('HappierComposerInput');
        await act(async () => {
            view.props.onComposerReferencePress({ nativeEvent: { ref: 'session:auth' } });
            view.props.onComposerDecorationPress({ nativeEvent: { url: 'https://example.test/context' } });
            view.props.onComposerDecorationPress({ nativeEvent: { url: 'javascript:alert(1)' } });
        });
        expect(onOpen).toHaveBeenCalledOnce();
        expect(openUrl.mock.calls).toEqual([['https://example.test/context']]);
    });

    it('restores the typed binding on native undo after the parent drops a deleted reference', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const token = formatInlineReferenceTokenV1({ ref: 'session:auth', label: 'Auth' });
        const reference = { ref: 'session:auth', token, start: 0, end: token.length, kind: 'session', label: 'Auth', binding: { id: 'auth' } };
        const onReferencesChange = vi.fn();
        const screen = await renderScreen(<MultiTextInput value={token} references={[reference]}
            onChangeText={() => {}} onReferencesChange={onReferencesChange} />);
        act(() => screen.tree.findByType('HappierComposerInput').props.onComposerChange({ nativeEvent: {
            text: '', selection: { start: 0, end: 0 }, eventCount: 1, references: [],
        } }));
        await screen.update(<MultiTextInput value="" references={[]} onChangeText={() => {}} onReferencesChange={onReferencesChange} />);
        act(() => screen.tree.findByType('HappierComposerInput').props.onComposerChange({ nativeEvent: {
            text: token, selection: { start: token.length, end: token.length }, eventCount: 2,
            references: [{ ref: reference.ref, token, start: 0, end: token.length }],
        } }));
        expect(onReferencesChange).toHaveBeenLastCalledWith([reference]);
        expect(onReferencesChange.mock.calls.at(-1)?.[0][0].binding).toBe(reference.binding);
    });

    it('keeps full large text editable and uses the exact native UTF16 caret after a middle paste', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const ref = React.createRef<MultiTextInputHandle>();
        const onStateChange = vi.fn();
        const text = `before ${'😀'.repeat(30_000)} after`;
        const caret = text.length - ' after'.length;
        const screen = await renderScreen(<MultiTextInput ref={ref} value="before after"
            onChangeText={() => {}} onStateChange={onStateChange} />);
        act(() => screen.tree.findByType('HappierComposerInput').props.onComposerChange({ nativeEvent: {
            text, selection: { start: caret, end: caret }, eventCount: 1, references: [],
        } }));
        expect(ref.current?.getText()).toBe(text);
        expect(onStateChange).toHaveBeenLastCalledWith({ text, selection: { start: caret, end: caret } });
    });

    it('uses UI font scaling and clamps only the viewport while reporting full content height', async () => {
        storage.setState({ localSettings: { ...storage.getState().localSettings, uiFontScale: 1.25 } });
        const { MultiTextInput } = await import('./MultiTextInput');
        const onContentHeightChange = vi.fn();
        const screen = await renderScreen(<MultiTextInput value="hello" textStyle={{ fontSize: 16 }}
            maxHeight={144} onChangeText={() => {}} onContentHeightChange={onContentHeightChange} />);
        expect(screen.tree.findByType('HappierComposerInput').props.typography.fontSize).toBe(20);
        act(() => screen.tree.findByType('HappierComposerInput').props.onComposerContentHeightChange({ nativeEvent: { height: 260 } }));
        expect(screen.tree.findByType('HappierComposerInput').props.style.height).toBe(144);
        expect(onContentHeightChange).toHaveBeenCalledWith(260);
    });

    it('keeps bound references and editable decoration ranges distinct across the native boundary', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const text = 'see [photo](happier-ref:attachment:picture) next';
        const token = formatInlineReferenceTokenV1({ ref: 'attachment:picture', label: 'photo' });
        const references = [{ start: 4, end: 4 + token.length, token, ref: 'attachment:picture', label: 'Image #1', kind: 'image', state: 'ready' }] as const;
        const decorations = [{ start: 0, end: 3, treatment: 'code', label: 'Code' }] as const;
        const screen = await renderScreen(<MultiTextInput value={text} references={references} decorations={decorations}
            onChangeText={() => {}} accessibilityLabel="Message" accessibilityRole="combobox" accessibilityState={{ expanded: true }} />);
        const view = screen.tree.findByType('HappierComposerInput');
        expect(view.props.value).toBe(text);
        expect(view.props.references).toEqual(references.map(reference => ({ ...reference, glyph: 'photo' })));
        expect(view.props.decorations).toEqual(decorations);
        expect(view.props.accessibilityLabel).toBe('Message');
        expect(view.props.accessibilityRole).toBe('combobox');
        expect(view.props.accessibilityState).toEqual({ expanded: true });
        expect(screen.tree.findAllByType('TextInput')).toHaveLength(0);
    });

    it('projects editor-only presentation and source bindings out of the native view props', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const token = formatInlineReferenceTokenV1({ ref: 'session:auth', label: 'Auth' });
        const references = [{ start: 0, end: token.length, ref: 'session:auth', label: 'Auth', kind: 'happier.session',
            token, readableMarker: '@Session "Auth"',
            binding: { kind: 'happier.session', ref: 'session:auth' }, thumbnail: <View />,
            onOpen: () => {},
        }];
        const screen = await renderScreen(<MultiTextInput value={references[0].token} references={references} onChangeText={() => {}} />);
        expect(screen.tree.findByType('HappierComposerInput').props.references).toEqual([{
            token, start: 0, end: token.length, ref: 'session:auth', label: 'Auth', kind: 'happier.session', marker: '@Session "Auth"', glyph: 'bubble.left',
        }]);
    });

    it('keeps native source selection authoritative for text edits before the controlled echo', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const onChangeText = vi.fn();
        const onStateChange = vi.fn();
        const onSelectionChange = vi.fn();
        const ref = React.createRef<MultiTextInputHandle>();
        const screen = await renderScreen(<MultiTextInput ref={ref} value="before after"
            onChangeText={onChangeText} onStateChange={onStateChange} onSelectionChange={onSelectionChange} />);
        const view = screen.tree.findByType('HappierComposerInput');
        await act(async () => {
            view.props.onComposerChange({ nativeEvent: { text: 'before 😀 after', selection: { start: 9, end: 9 }, eventCount: 1, references: [] } });
            view.props.onComposerSelection({ nativeEvent: { selection: { start: 7, end: 9 } } });
        });
        expect(ref.current?.getText()).toBe('before 😀 after');
        expect(ref.current?.flushPendingTextChange()).toBe('before 😀 after');
        expect(onChangeText).toHaveBeenCalledWith('before 😀 after');
        expect(onStateChange).toHaveBeenLastCalledWith({ text: 'before 😀 after', selection: { start: 7, end: 9 } });
        expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 7, end: 9 });
    });

    it('does not dispatch an idle drop-caret clear while mounting or retiring a native editor', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const ref = React.createRef<MultiTextInputHandle>();
        const native = { setDropCaret: vi.fn() };
        const screen = await renderScreen(<MultiTextInput ref={ref} value="abc" onChangeText={() => {}} />, {
            createNodeMock: element => element.type === 'HappierComposerInput' ? native : null,
        });
        const handle = ref.current!;
        // Drop-target mount and cleanup both clear feedback without an active drag.
        handle.setDropCaret(null);
        handle.setDropCaret(null);
        expect(native.setDropCaret).not.toHaveBeenCalled();
        await screen.unmount();
        handle.setDropCaret(null);
        expect(native.setDropCaret).not.toHaveBeenCalled();
    });

    it('uses the native window-point hit test and imperative drop caret without rerendering', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const ref = React.createRef<MultiTextInputHandle>();
        const native = {
            focus: vi.fn(), blur: vi.fn(), setSelection: vi.fn(), setTextAndSelection: vi.fn(),
            offsetAtPoint: vi.fn(async () => 2), setDropCaret: vi.fn(),
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(10, 20, 300, 40),
        };
        await renderScreen(<MultiTextInput ref={ref} value="abc" onChangeText={() => {}} />, {
            createNodeMock: element => element.type === 'HappierComposerInput' ? native : null,
        });
        expect(await ref.current?.offsetAtPoint({ x: 25, y: 35 })).toBe(2);
        ref.current?.setDropCaret(2);
        ref.current?.setDropCaret(null);
        expect(native.offsetAtPoint).toHaveBeenCalledWith(25, 35);
        expect(native.setDropCaret.mock.calls).toEqual([[2], [null]]);
        ref.current?.focus(); ref.current?.blur();
        expect(native.focus).toHaveBeenCalledOnce(); expect(native.blur).toHaveBeenCalledOnce();
        const measured = vi.fn(); ref.current?.measureInWindow(measured);
        expect(measured).toHaveBeenCalledWith(10, 20, 300, 40);
        expect(ref.current?.getReactNodeTag()).toBe(42);
    });

    it('preserves source state for dictation and selection restoration through native commands', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const ref = React.createRef<MultiTextInputHandle>();
        const native = { setTextAndSelection: vi.fn(), setSelection: vi.fn() };
        const onStateChange = vi.fn();
        await renderScreen(<MultiTextInput ref={ref} value="hello" onChangeText={() => {}} onStateChange={onStateChange} />, {
            createNodeMock: element => element.type === 'HappierComposerInput' ? native : null,
        });
        act(() => ref.current?.setTextAndSelection('hello world', { start: 11, end: 11 }));
        expect(ref.current?.getText()).toBe('hello world');
        expect(native.setTextAndSelection).toHaveBeenCalledWith('hello world', { start: 11, end: 11 }, []);
        expect(onStateChange).toHaveBeenLastCalledWith({ text: 'hello world', selection: { start: 11, end: 11 } });
    });

    it('rebases existing typed references with the text and caret in one native command', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const token = formatInlineReferenceTokenV1({ ref: 'session:auth', label: 'Auth' });
        const reference = { ref: 'session:auth', token, start: 0, end: token.length, kind: 'session', label: 'Auth', binding: { id: 'auth' } };
        const ref = React.createRef<MultiTextInputHandle>();
        const native = { setTextAndSelection: vi.fn(), setSelection: vi.fn() };
        const onReferencesChange = vi.fn();
        await renderScreen(<MultiTextInput ref={ref} value={token} references={[reference]}
            onChangeText={() => {}} onReferencesChange={onReferencesChange} />, {
            createNodeMock: element => element.type === 'HappierComposerInput' ? native : null,
        });
        act(() => ref.current?.setSelection({ start: 0, end: 0 }));
        act(() => ref.current?.setTextAndSelection(`Hi ${token}`, { start: 3, end: 3 }));
        expect(native.setTextAndSelection).toHaveBeenLastCalledWith(`Hi ${token}`, { start: 3, end: 3 }, [
            expect.objectContaining({ ref: reference.ref, start: 3, end: token.length + 3 }),
        ]);
        expect(onReferencesChange).toHaveBeenLastCalledWith([{ ...reference, start: 3, end: token.length + 3 }]);
        expect(onReferencesChange.mock.calls.at(-1)?.[0][0].binding).toBe(reference.binding);
    });

    it('delivers namespaced native events through the public composer callbacks', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const onContentHeightChange = vi.fn(), onScrollYChange = vi.fn(), onFocus = vi.fn(), onBlur = vi.fn();
        const onSubmitEditing = vi.fn(), onKeyPress = vi.fn(() => false), onChangeText = vi.fn();
        const screen = await renderScreen(<MultiTextInput value="hello" onChangeText={onChangeText}
            maxHeight={144} initialScrollY={25} scrollRestoreToken="draft-a" submitBehavior="submit"
            onContentHeightChange={onContentHeightChange} onScrollYChange={onScrollYChange}
            onFocus={onFocus} onBlur={onBlur} onSubmitEditing={onSubmitEditing} onKeyPress={onKeyPress} />);
        const view = screen.tree.findByType('HappierComposerInput');
        act(() => {
            view.props.onComposerChange({ nativeEvent: { text: 'hello!', selection: { start: 6, end: 6 }, eventCount: 1, references: [] } });
            view.props.onComposerContentHeightChange({ nativeEvent: { height: 220.4 } });
            view.props.onComposerContentHeightChange({ nativeEvent: { height: 220.4 } });
            view.props.onComposerScroll({ nativeEvent: { y: 25 } }); view.props.onComposerFocus(); view.props.onComposerBlur();
            view.props.onComposerSubmitEditing();
            view.props.onComposerKeyPress({ nativeEvent: { key: 'Enter', shiftKey: true, metaKey: true } });
        });
        expect(onChangeText).toHaveBeenCalledWith('hello!');
        expect(onContentHeightChange.mock.calls).toEqual([[221]]);
        expect(onScrollYChange).toHaveBeenCalledWith(25);
        expect(onFocus).toHaveBeenCalledOnce(); expect(onBlur).toHaveBeenCalledOnce();
        expect(onSubmitEditing).toHaveBeenCalledOnce();
        expect(onKeyPress).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter', shiftKey: true, metaKey: true,
            inputState: { text: 'hello!', selection: { start: 6, end: 6 } } }));
    });
});
