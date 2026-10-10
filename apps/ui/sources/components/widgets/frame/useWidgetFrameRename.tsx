import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * Rename in place for a widget frame's title, on every surface (lab `dashboards` dbind E: "Rename
 * stays optional in ⋯"). `begin` is what the ⋯ menu's Rename (and, where the title presses, the
 * title) calls; while renaming, `field` takes the title's place. Enter or leaving the field keeps
 * the name, Escape keeps the old one. The surface decides what an empty or unchanged name means.
 */
export function useWidgetFrameRename(input: Readonly<{
    title: string;
    /** The surface's rename write; absent when this viewer cannot rename the copy. */
    onRename?: (next: string) => void | Promise<void>;
    testID: string;
}>): Readonly<{ begin: (() => void) | undefined; field: React.ReactElement | null }> {
    const [renaming, setRenaming] = React.useState(false);
    const onRename = input.onRename;
    const begin = React.useCallback(() => setRenaming(true), []);
    const commit = React.useCallback(async (next: string): Promise<boolean> => {
        try {
            await onRename?.(next);
            setRenaming(false);
            return true;
        } catch {
            Modal.alert(t('common.error'), t('widgetAdd.saveFailed'));
            return false;
        }
    }, [onRename]);
    const cancel = React.useCallback(() => setRenaming(false), []);
    return {
        begin: onRename ? begin : undefined,
        field: renaming && onRename ? (
            <WidgetFrameTitleField value={input.title} onCommit={commit} onCancel={cancel} testID={`${input.testID}-title-input`} />
        ) : null,
    };
}

/**
 * The same title field, standing where a name is always editable: a group's bar while customizing
 * (lab widget-groups wgmenu E). Enter or leaving the field keeps the name, Escape puts the saved one
 * back; an unchanged name writes nothing. The surface decides what an empty name means.
 */
export function WidgetFrameNameField(props: Readonly<{
    value: string;
    placeholder: string;
    accessibilityLabel: string;
    onRename: (next: string) => void | Promise<void>;
    testID: string;
}>): React.ReactElement {
    const onRename = props.onRename;
    const commit = React.useCallback(async (next: string): Promise<boolean> => {
        try {
            await onRename(next);
            return true;
        } catch {
            Modal.alert(t('common.error'), t('widgetAdd.saveFailed'));
            return false;
        }
    }, [onRename]);
    return <WidgetFrameTitleField persistent value={props.value} placeholder={props.placeholder}
        accessibilityLabel={props.accessibilityLabel} onCommit={commit} testID={props.testID} />;
}

function WidgetFrameTitleField(props: Readonly<{
    value: string;
    onCommit: (next: string) => Promise<boolean>;
    onCancel?: () => void;
    /** Stays mounted as a bordered field instead of taking the title's place for one edit. */
    persistent?: boolean;
    placeholder?: string;
    accessibilityLabel?: string;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [draft, setDraft] = React.useState(props.value);
    const [saving, setSaving] = React.useState(false);
    // A persistent field follows its saved name whenever that changes (a rename from elsewhere, an undo).
    const [saved, setSaved] = React.useState(props.value);
    if (saved !== props.value) {
        setSaved(props.value);
        setDraft(props.value);
    }
    // Enter, blur and Escape can each arrive; only the first one decides.
    const settled = React.useRef(false);
    const finish = (keep: boolean) => {
        if (settled.current) return;
        if (props.persistent) {
            const next = draft.trim();
            if (!keep || next === props.value) {
                setDraft(props.value);
                return;
            }
            settled.current = true;
            setSaving(true);
            void props.onCommit(next).then(() => {
                settled.current = false;
                setSaving(false);
            });
            return;
        }
        settled.current = true;
        if (keep) {
            setSaving(true);
            void props.onCommit(draft.trim()).then(saved => {
                if (!saved) {
                    settled.current = false;
                    setSaving(false);
                }
            });
        } else props.onCancel?.();
    };
    return (
        <TextInput
            testID={props.testID}
            style={[styles.input, props.persistent ? styles.field : null]}
            value={draft}
            editable={!saving}
            accessibilityState={{ busy: saving }}
            autoFocus={!props.persistent}
            selectTextOnFocus
            {...(props.placeholder ? { placeholder: props.placeholder, placeholderTextColor: theme.colors.text.tertiary } : {})}
            accessibilityLabel={props.accessibilityLabel ?? t('sessionBoard.item.renameA11y')}
            onChangeText={setDraft}
            onSubmitEditing={() => finish(true)}
            onBlur={() => finish(true)}
            onKeyPress={(event) => {
                if (event.nativeEvent.key === 'Escape') finish(false);
            }}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    // The frame title's own type, so renaming never shifts the header.
    input: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('sectionTitle'),
        color: theme.colors.text.primary,
        paddingVertical: 2,
    },
    // Always there: it reads as a field, at the control radius, and gives way to the bar's controls.
    field: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 96,
        maxWidth: 220,
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: theme.borderRadius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
}));
