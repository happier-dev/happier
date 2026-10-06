import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
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

function WidgetFrameTitleField(props: Readonly<{
    value: string;
    onCommit: (next: string) => Promise<boolean>;
    onCancel: () => void;
    testID: string;
}>): React.ReactElement {
    const [draft, setDraft] = React.useState(props.value);
    const [saving, setSaving] = React.useState(false);
    // Enter, blur and Escape can each arrive; only the first one decides.
    const settled = React.useRef(false);
    const finish = (keep: boolean) => {
        if (settled.current) return;
        settled.current = true;
        if (keep) {
            setSaving(true);
            void props.onCommit(draft.trim()).then(saved => {
                if (!saved) {
                    settled.current = false;
                    setSaving(false);
                }
            });
        } else props.onCancel();
    };
    return (
        <TextInput
            testID={props.testID}
            style={styles.input}
            value={draft}
            editable={!saving}
            accessibilityState={{ busy: saving }}
            autoFocus
            selectTextOnFocus
            accessibilityLabel={t('sessionBoard.item.renameA11y')}
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
}));
