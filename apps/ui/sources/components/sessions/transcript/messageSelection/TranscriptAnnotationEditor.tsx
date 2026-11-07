import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ReplyQuote } from '@/components/ui/text/ReplyQuote';
import { Text } from '@/components/ui/text/Text';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { t } from '@/text';

/**
 * Shared by selection and attachment editing; the form keeps entered work on refusal.
 * Cmd/Ctrl+Enter adds (Enter stays a new line); Escape discards, even from inside the field.
 */
export function TranscriptAnnotationEditor(props: Readonly<{
    quote: string;
    note?: string;
    onSave: (note: string) => Promise<boolean>;
    onCancel: () => void;
    /** The current draft, for a host that must not drop typed work on an outside dismissal. */
    onNoteChange?: (note: string) => void;
    testID?: string;
}>) {
    const [note, setNote] = React.useState(props.note ?? '');
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState(false);
    const titleId = `${React.useId()}-title`;
    const changeNote = (next: string) => {
        setNote(next);
        setError(false);
        props.onNoteChange?.(next);
    };
    const save = async () => {
        if (saving || !note.trim()) return;
        setSaving(true);
        setError(false);
        try {
            if (await props.onSave(note.trim())) props.onCancel();
            else setError(true);
        } catch { setError(true); }
        finally { setSaving(false); }
    };
    // Nested inside its popover's layer, so an explicit Escape discards while an outside press does not.
    useEscapeLayer({ enabled: !saving, priority: ESCAPE_LAYER_PRIORITIES.popover, allowEditableTarget: true,
        onEscape: () => { props.onCancel(); return true; } });
    const id = props.testID ?? 'transcript-annotation-editor';
    return <View testID={id} style={styles.form}>
        <Text variant="label" emphasis="semiBold" accessibilityRole="header" nativeID={titleId}>
            {t('transcriptPassage.noteTitle')}
        </Text>
        <ReplyQuote testID={`${id}-quote`} kind="message" form="passage"
            source={{ state: 'available', label: t('transcriptPassage.quote'), text: props.quote }} />
        <FieldTextInput testID={`${id}-note`} value={note} onChangeText={changeNote}
            accessibilityLabel={t('transcriptPassage.note')} accessibilityLabelledBy={titleId}
            placeholder={t('transcriptPassage.notePlaceholder')}
            multiline growWithText autoFocus editable={!saving} error={error ? t('transcriptPassage.saveError') : null}
            onKeyPress={(event) => {
                const key = event.nativeEvent as typeof event.nativeEvent & { metaKey?: boolean; ctrlKey?: boolean };
                if (key.key !== 'Enter' || (!key.metaKey && !key.ctrlKey)) return;
                event.preventDefault?.();
                void save();
            }} />
        <View style={styles.buttons}>
            <RoundButton testID={`${id}-cancel`} size="small" display="inverted" title={t('common.cancel')}
                disabled={saving} onPress={props.onCancel} />
            <RoundButton testID={`${id}-save`} size="small" title={t(props.note === undefined ? 'common.add' : 'common.save')}
                disabled={saving || !note.trim()} loading={saving} action={save} />
        </View>
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    form: { padding: theme.space.s16, gap: theme.space.s12 },
    buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.space.s8 },
}));
