import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { HomeSettingEntryV1 } from '@happier-dev/protocol/home/governance';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { SchemaFieldRow } from '@/components/settings/schemaFields/SchemaFieldRow';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { t } from '@/text';

import { HomeDeploymentFixedNote } from './HomeDeploymentFixedNote';
import { isHomeSettingWritable } from './homeSettingDeclaration';

/** What an owner asked for a write-only setting: keep it, type a replacement, or clear it. */
export type HomeSecretDraft =
    | Readonly<{ mode: 'keep' }>
    | Readonly<{ mode: 'replace'; text: string }>
    | Readonly<{ mode: 'clear' }>;

export const KEEP_HOME_SECRET: HomeSecretDraft = Object.freeze({ mode: 'keep' as const });

/**
 * One write-only Home setting (plan §3.14, invariant I3): the value is never shown. A stored value
 * reads Saved · Replace · Clear; with none stored the row is a masked field; a key the deployment
 * fixed, or a viewer who cannot write, sees only whether it is set. The draft belongs to the page:
 * Email stages it until its page Save; row-level editors expose an explicit Save (`onCommit`).
 * Leaving or submitting the input never commits a secret.
 */
export const HomeSecretSettingRow = React.memo(function HomeSecretSettingRow(props: Readonly<{
    entry: HomeSettingEntryV1;
    title: string;
    subtitle?: string;
    titleAccessory?: React.ReactNode;
    draft: HomeSecretDraft;
    readOnly: boolean;
    disabled: boolean;
    error?: string | null;
    onChange: (draft: HomeSecretDraft) => void;
    /** With nothing stored, offer "Set" rather than an open field (Server settings, lab `hcServer`). */
    setWhenEmpty?: boolean;
    /** What to paste, inside the empty field ("Paste the key"). */
    placeholder?: string;
    /** A status mark before the subtitle (a missing or unreadable value). */
    subtitleLeading?: React.ReactNode;
    /** The facts under the label, rendered after the subtitle. */
    subtitleAccessory?: React.ReactNode;
    /** Exposes an explicit Save for this row; omitted when the page owns Save. */
    onCommit?: () => void;
    showDivider?: boolean;
    testID: string;
}>) {
    const { entry, draft, onChange, onCommit, testID, title } = props;
    const handleText = React.useCallback((text: string) => onChange({ mode: 'replace', text }), [onChange]);
    const saved = entry.secretSet === true;
    // The shared schema-field row draws the label and hint; this row owns only the write-only states.
    const common = {
        testID,
        title,
        titleAccessory: props.titleAccessory,
        hintLeading: props.subtitleLeading,
        hintAccessory: props.subtitleAccessory,
        showDivider: props.showDivider,
    } as const;
    if (entry.fixed || props.readOnly || !isHomeSettingWritable(entry)) {
        return (
            <SchemaFieldRow
                {...common}
                hint={props.subtitle}
                hintAccessory={props.subtitleAccessory ?? (entry.fixed ? <HomeDeploymentFixedNote keys={[entry.key]} testID={testID} /> : undefined)}
                layout="inline"
                value={saved
                    ? (entry.fixed ? t('homeSettings.secret.valueSet') : t('homeSettings.secret.saved'))
                    : t('homeSettings.secret.valueNotSet')}
            />
        );
    }
    const keep = (
        <RoundButton
            testID={`${testID}-keep`}
            size="small"
            display="inverted"
            title={t('homeSettings.secret.keep')}
            disabled={props.disabled}
            onPress={() => onChange(KEEP_HOME_SECRET)}
        />
    );
    const save = onCommit ? (
        <RoundButton
            testID={`${testID}-save`}
            size="small"
            title={t('common.save')}
            disabled={props.disabled || draft.mode === 'keep' || (draft.mode === 'replace' && !draft.text)}
            onPress={onCommit}
        />
    ) : null;
    if (!saved && draft.mode === 'keep' && props.setWhenEmpty) {
        return (
            <SchemaFieldRow
                {...common}
                hint={props.subtitle}
                layout="inline"
                control={(
                    <RoundButton
                        testID={`${testID}-set`}
                        size="small"
                        display="secondary"
                        title={t('homeSettings.secret.setAction')}
                        disabled={props.disabled}
                        onPress={() => onChange({ mode: 'replace', text: '' })}
                    />
                )}
            />
        );
    }
    if (saved && draft.mode === 'clear') {
        return (
            <SchemaFieldRow
                {...common}
                hint={t('homeSettings.secret.clearPending')}
                layout="adaptive"
                control={<View style={styles.inlineControls}>{keep}{save}</View>}
            />
        );
    }
    if (saved && draft.mode === 'keep') {
        return (
            <SchemaFieldRow
                {...common}
                hint={props.subtitle}
                layout="adaptive"
                control={(
                    <View style={styles.inlineControls}>
                        <StatusPill testID={`${testID}-saved`} variant="neutral" label={t('homeSettings.secret.saved')} />
                        <RoundButton
                            testID={`${testID}-replace`}
                            size="small"
                            display="secondary"
                            title={t('homeSettings.secret.replace')}
                            disabled={props.disabled}
                            onPress={() => onChange({ mode: 'replace', text: '' })}
                        />
                        <RoundButton
                            testID={`${testID}-clear`}
                            size="small"
                            display="inverted"
                            title={t('homeSettings.secret.clear')}
                            disabled={props.disabled}
                            onPress={() => onChange({ mode: 'clear' })}
                        />
                    </View>
                )}
            />
        );
    }
    return (
        <SchemaFieldRow
            {...common}
            hint={props.subtitle}
            layout="adaptive"
            control={(
                <View style={styles.inlineControls}>
                    <FieldTextInput
                        testID={`${testID}-input`}
                        accessibilityLabel={title}
                        value={draft.mode === 'replace' ? draft.text : ''}
                        placeholder={props.placeholder}
                        editable={!props.disabled}
                        secureTextEntry
                        autoCapitalize="none"
                        autoComplete="off"
                        autoFocus={saved || props.setWhenEmpty === true}
                        error={props.error ?? null}
                        onChangeText={handleText}
                        style={styles.grow}
                    />
                    {saved || props.setWhenEmpty ? keep : null}
                    {save}
                </View>
            )}
        />
    );
});

const styles = StyleSheet.create(() => ({
    inlineControls: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        flexShrink: 1,
        maxWidth: '100%',
    },
    grow: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 160,
    },
}));
