import type { ComposerEditorDecoration } from './composerEditor/composerEditorTypes';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';
import type { CaretRect } from '@/hooks/ui/textInputCaretRect/useTextInputCaretRect.types';
import type { KeyboardKeyPressEventInput } from '@/keyboard/events';
import type { AttachmentUploadSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';

export type NativeComposerAttachmentDrop = Readonly<{
    sources: readonly AttachmentUploadSource[];
    offset: number;
    error?: boolean;
}>;

export type ComposerInputReference = Readonly<{
    token: string;
    start: number;
    end: number;
    ref: string;
    label: string;
    kind: string;
    state?: 'ready' | 'pending' | 'unavailable' | 'removed';
    glyph?: string;
    marker?: string;
    accessibilityLabel?: string;
}>;

export type ComposerInputDecoration = ComposerEditorDecoration;

type Selection = Readonly<{ start: number; end: number }>;
type NativeInputGeometry = Readonly<{ nativeInputTag?: number; caretRect?: CaretRect | null }>;
type NativeBoundReference = Readonly<{ ref: string; token: string; start: number; end: number }>;

export type NativeComposerInputCommandResult =
    | Readonly<{ kind: 'applied' }>
    | Readonly<{ kind: 'not_attached'; reason: 'native_view_missing' }>;

/** Expo rejects an AsyncFunction when the native view was torn down before the command reached it. */
export function classifyNativeComposerInputCommandError(error: unknown): NativeComposerInputCommandResult | null {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    return /Unable to find (?:the )?'?HappierComposerInputView'? view/i.test(message)
        ? { kind: 'not_attached', reason: 'native_view_missing' }
        : null;
}

/** The module's `AsyncFunction` commands settle as promises; a view gone by the time one runs rejects it. */
export type NativeComposerInputHandle = Readonly<{
    focus: () => Promise<void> | void;
    blur: () => Promise<void> | void;
    setTextAndSelection: (text: string, selection: Selection, references: readonly ComposerInputReference[]) => Promise<void> | void;
    setSelection: (selection: Selection) => Promise<void> | void;
    offsetAtPoint: (x: number, y: number) => Promise<number | null>;
    setDropCaret: (offset: number | null) => Promise<void> | void;
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void;
}>;

// Expo direct events share React Native's global registry with bubbling TextInput events.
export type NativeComposerInputProps = Omit<ViewProps, 'onFocus' | 'onBlur'> & Readonly<{
    value: string;
    mostRecentEventCount: number;
    references: readonly ComposerInputReference[];
    decorations: readonly ComposerInputDecoration[];
    theme: Readonly<{
        text: string; placeholder: string; chipForeground: string; chipGlyphForeground: string; chipBackground: string;
        selection: string; warning: string; success: string; muted: string; link: string;
    }>;
    typography: Readonly<{
        fontFamily?: string; fontSize: number; lineHeight: number; fontWeight?: string;
        chipFontFamily?: string; monoFontFamily?: string; chipHeight: number; chipRadius: number; chipMaxLabelWidth: number;
        chipPaddingLeft: number; chipPaddingRight: number; chipGlyphSize: number; chipGap: number;
    }>;
    padding: Readonly<{ top: number; bottom: number; left: number; right: number }>;
    minHeight: number;
    maxHeight: number;
    editable: boolean;
    forwardHardwareBack?: boolean;
    placeholder: string;
    returnKeyType: 'send' | 'default';
    submitBehavior: 'newline' | 'submit' | 'blurAndSubmit';
    autoFocus: boolean;
    autoCorrect: boolean;
    autoCapitalize: 'sentences';
    initialScrollY?: number;
    scrollRestoreToken?: string;
    referenceMenuLabels: Readonly<{ open: string; remove: string }>;
    acceptsAttachmentDrops: boolean;
    attachmentDropScope: string;
    onComposerAttachmentDrop: (event: NativeSyntheticEvent<NativeComposerAttachmentDrop & Readonly<{ scope: string }>>) => void;
    onComposerChange: (event: NativeSyntheticEvent<NativeInputGeometry & Readonly<{ text: string; selection: Selection; eventCount: number; references: readonly NativeBoundReference[] }>>) => void;
    onComposerSelection: (event: NativeSyntheticEvent<NativeInputGeometry & Readonly<{ selection: Selection }>>) => void;
    onComposerKeyPress: (event: NativeSyntheticEvent<KeyboardKeyPressEventInput & Readonly<{ submitting?: boolean }>>) => void;
    onComposerFocus: (event?: NativeSyntheticEvent<NativeInputGeometry>) => void;
    onComposerBlur?: () => void;
    onComposerSubmitEditing?: (event?: NativeSyntheticEvent<KeyboardKeyPressEventInput>) => void;
    onComposerContentHeightChange: (event: NativeSyntheticEvent<Readonly<{ height: number }>>) => void;
    onComposerScroll: (event: NativeSyntheticEvent<NativeInputGeometry & Readonly<{ y: number }>>) => void;
    onComposerReferencePress?: (event: NativeSyntheticEvent<Readonly<{ ref: string }>>) => void;
    onComposerDecorationPress?: (event: NativeSyntheticEvent<Readonly<{ url: string }>>) => void;
}>;
