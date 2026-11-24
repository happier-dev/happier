import * as React from 'react';
import {
    HappierTechnicalDetailsDisclosure,
    happierPageTextMetrics,
    type HappierTechnicalDetailsContentProps,
    type HappierTechnicalDetailsLine,
    type HappierTechnicalDetailsTextRender,
} from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { HappierDisclosureToggle } from '@happier-dev/plugin-ui/presentation';
import { View } from 'react-native';

import { CountedDisclosureItem } from '@/components/ui/lists/CountedDisclosureItem';
import { useCoreDisclosureToggleBinding } from '@/components/ui/lists/DisclosureCaret';
import { useItemGroupRowPosition } from '@/components/ui/lists/ItemGroupRowPosition';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export type TechnicalDetailsLine = HappierTechnicalDetailsLine;

function TechnicalDetailsBody(props: Readonly<{ children: React.ReactNode }>) {
    return <SectionContentRow>{props.children}</SectionContentRow>;
}

/** Inside a card, row, dock or banner: the small "Details ›" toggle, its lines opening under it. */
function InlineTechnicalDetailsFold(props: Readonly<{ title: string; testID?: string; children: React.ReactNode }>) {
    const disclosure = useCoreDisclosureToggleBinding();
    const [open, setOpen] = React.useState(false);
    return (
        <View>
            <HappierDisclosureToggle
                testID={props.testID}
                label={props.title}
                open={open}
                onPress={() => setOpen((value) => !value)}
                caret={disclosure.renderCaret(open)}
                renderLabel={disclosure.renderLabel}
                focusColor={disclosure.focusColor}
            />
            {open ? props.children : null}
        </View>
    );
}

function InlineTechnicalDetailsBody(props: Readonly<{ children: React.ReactNode }>) {
    return <View style={styles.inlineBody}>{props.children}</View>;
}

// Core's text adapter, so the `uiFontScale` local setting applies to the reference lines.
const renderTechnicalDetailsText: HappierTechnicalDetailsTextRender = (input) => input.role === 'value' ? (
    <Text selectable style={styles.value}>{input.text}</Text>
) : (
    <Text style={styles.label}>{input.text}</Text>
);

/**
 * Happier core's binding of the shared disclosure (approvals, Run steps, failure rows and cards): its
 * density-scaled spacing and typography, and its density from where it sits, never from the caller. As a
 * direct row of a section (`ItemGroupRowPosition`) it is the full counted-disclosure row; inside a card,
 * row, dock or banner it is the small inline toggle (UI refinements ruling 2026-11-24). A card inside a
 * section opts out with `ItemGroupRowPositionBoundary`. The caller's title says what it reveals:
 * "Details" for facts a person may want, "Technical details" for codes, ids and diagnostics.
 * The composition is `HappierTechnicalDetailsDisclosure` in `@happier-dev/plugin-ui`.
 */
export function TechnicalDetailsDisclosure(props: HappierTechnicalDetailsContentProps) {
    const { theme } = useUnistyles();
    const space = React.useMemo(() => ({ s4: theme.space.s4 }), [theme.space.s4]);
    const sectionRow = useItemGroupRowPosition() !== null;
    return (
        <HappierTechnicalDetailsDisclosure
            {...props}
            Disclosure={sectionRow ? CountedDisclosureItem : InlineTechnicalDetailsFold}
            Body={sectionRow ? TechnicalDetailsBody : InlineTechnicalDetailsBody}
            renderText={renderTechnicalDetailsText}
            space={space}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    inlineBody: {
        paddingTop: theme.space.s4,
    },
    label: {
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.tertiary,
    },
    value: {
        ...happierPageTextMetrics('rowDescription'),
        ...Typography.mono(),
        minWidth: 0,
        color: theme.colors.text.secondary,
    },
}));
