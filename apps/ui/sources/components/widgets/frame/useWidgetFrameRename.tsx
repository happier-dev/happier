import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { View } from 'react-native';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { HomeReachabilityGate, useFailureExplainedByUnreachableHome } from '@/components/navigation/connectionStatus/HomeReachabilityGate';

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
    /** Exact writer target, when this surface has one; never inferred from the focused Home. */
    serverId?: string | null;
}>): Readonly<{ begin: (() => void) | undefined; field: React.ReactElement | null }> {
    const [renaming, setRenaming] = React.useState(false);
    const onRename = input.onRename;
    const commands = useCurrentUiContextLocalCommands(onRename ? [{ key: renaming ? 'cancel' : 'begin',
        title: `${t(renaming ? 'common.cancel' : 'common.rename')}: ${input.title}`,
        invoke: () => setRenaming(!renaming) }] : [], { unbound: 'local' });
    const begin = React.useCallback(() => { void commands.invoke('begin'); }, [commands]);
    const commit = React.useCallback(async (next: string): Promise<boolean> => {
        try {
            await onRename?.(next);
            setRenaming(false);
            return true;
        } catch (error) {
            Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(error, t('widgetAdd.saveFailed')));
            return false;
        }
    }, [onRename]);
    const cancel = React.useCallback(() => { void commands.invoke('cancel'); }, [commands]);
    return {
        begin: onRename ? begin : undefined,
        field: renaming && onRename ? (
            <WidgetFrameTitleField value={input.title} onCommit={commit} onCancel={cancel} testID={`${input.testID}-title-input`} serverId={input.serverId} />
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
    serverId?: string | null;
}>): React.ReactElement {
    const onRename = props.onRename;
    const commit = React.useCallback(async (next: string): Promise<boolean> => {
        try {
            await onRename(next);
            return true;
        } catch (error) {
            Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(error, t('widgetAdd.saveFailed')));
            return false;
        }
    }, [onRename]);
    return <WidgetFrameTitleField persistent value={props.value} placeholder={props.placeholder}
        accessibilityLabel={props.accessibilityLabel} onCommit={commit} testID={props.testID} serverId={props.serverId} />;
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
    serverId?: string | null;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [draft, setDraft] = React.useState(props.value);
    const [saving, setSaving] = React.useState(false);
    const commands = useCurrentUiContextLocalCommands(saving ? [] : [{ key: 'draft', title: `${t('common.rename')}: ${props.value}`,
        invoke: value => { if (typeof value !== 'string') return false; setDraft(value); } }], { unbound: 'local' });
    const homeUnreachable = useFailureExplainedByUnreachableHome(saving && props.serverId ? [props.serverId] : []);
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
    const input = (
        <TextInput
            testID={props.testID}
            style={[styles.input, props.persistent ? styles.fieldInput : null]}
            value={draft}
            editable={!saving}
            accessibilityState={{ busy: saving && !homeUnreachable }}
            autoFocus={!props.persistent}
            selectTextOnFocus
            {...(props.placeholder ? { placeholder: props.placeholder, placeholderTextColor: theme.colors.text.tertiary } : {})}
            accessibilityLabel={props.accessibilityLabel ?? t('sessionBoard.item.renameA11y')}
            onChangeText={value => { void commands.invoke('draft', value); }}
            onSubmitEditing={() => finish(true)}
            onBlur={() => finish(true)}
            onKeyPress={(event) => {
                if (event.nativeEvent.key === 'Escape') finish(false);
            }}
        />
    );
    return (
        <>
        {props.persistent ? (
            // The field is as wide as its name, up to the room the bar has; past that the name ends in an ellipsis.
            // An unseen copy of the text gives the box its width, the input sits over it.
            <View style={styles.field}>
                <Text style={[styles.input, styles.sizer]} numberOfLines={1} aria-hidden>{draft || props.placeholder || ' '}</Text>
                {input}
            </View>
        ) : input}
        {saving && props.serverId ? <HomeReachabilityGate variant="line" relevantServerIds={[props.serverId]}>{null}</HomeReachabilityGate> : null}
        </>
    );
}

// react-native-web draws a clipped single-line input with an ellipsis through this web-only property.
const WEB_TEXT_OVERFLOW = { textOverflow: 'ellipsis' };

const styles = StyleSheet.create((theme) => ({
    // The frame title's own type, so renaming never shifts the header.
    input: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('sectionTitle'),
        color: theme.colors.text.primary,
        paddingVertical: theme.space.s2,
    },
    // Always there: it reads as a field, at the control radius, and gives way to the bar's controls.
    field: {
        flexShrink: 1,
        minWidth: 96,
        paddingVertical: theme.space.s4,
        paddingHorizontal: theme.space.s10,
        borderRadius: theme.borderRadius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    fieldInput: {
        position: 'absolute',
        left: theme.space.s10,
        right: theme.space.s10,
        top: theme.space.s4,
        bottom: theme.space.s4,
        paddingVertical: 0,
        paddingHorizontal: 0,
        ...WEB_TEXT_OVERFLOW,
    },
    sizer: { opacity: 0, paddingVertical: 0 },
}));
