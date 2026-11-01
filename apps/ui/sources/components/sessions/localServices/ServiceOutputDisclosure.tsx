import { HappierDisclosureToggle } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { DisclosedCodeText, useCoreDisclosureToggleBinding } from '@/components/ui/lists/DisclosureCaret';
import type { LocalServiceOutputRecovery } from '@/sync/domains/local/services/serviceFailure';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        gap: theme.space.s6,
    },
    start: {
        alignItems: 'flex-start',
    },
    // A centred card column hugs its children; the disclosure takes the column's width so its
    // toggle centres on the card's axis and the open output reads at the sentence's measure.
    center: {
        alignSelf: 'stretch',
        alignItems: 'center',
    },
    block: {
        alignSelf: 'stretch',
        gap: theme.space.s2,
        padding: theme.space.s8,
        borderRadius: theme.borderRadius.md,
        backgroundColor: theme.colors.surface.inset,
    },
}));

/**
 * "Review output": a failed start's sanitized output, opened in place. One disclosure for every
 * place a failed Service is shown — its Services row (on the title's edge, lab `db`'s reason line)
 * and the Browser card for its ended preview (centred under the sentence, lab ST). Closed, the
 * failure stays one quiet line, drawn like the card's Details beside it (one disclosure look).
 */
export function ServiceOutputDisclosure(props: Readonly<{
    output: LocalServiceOutputRecovery;
    /** The edge the toggle sits on: a row's title edge, or a centred state card's axis. */
    align?: 'start' | 'center';
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const binding = useCoreDisclosureToggleBinding();
    const [open, setOpen] = React.useState(false);
    const toggle = React.useCallback(() => setOpen((value) => !value), []);
    return (
        <View testID={`${props.testID}-output`} style={[styles.root, props.align === 'center' ? styles.center : styles.start]}>
            <HappierDisclosureToggle
                testID={`${props.testID}-output-toggle`}
                label={props.output.label}
                open={open}
                onPress={toggle}
                align={props.align}
                caret={binding.renderCaret(open)}
                renderLabel={binding.renderLabel}
                focusColor={binding.focusColor}
            />
            {open ? (
                <View testID={`${props.testID}-output-lines`} style={styles.block}>
                    {/* Output can repeat a line, so its position is its identity. */}
                    {props.output.lines.map((line, index) => <DisclosedCodeText key={index}>{line}</DisclosedCodeText>)}
                </View>
            ) : null}
        </View>
    );
}
