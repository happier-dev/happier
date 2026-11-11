import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { usePageListInsets } from '@/components/ui/lists/listPresentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * One step of a sign-in or configuration form. On its own it is a page section; `embedded` places it
 * inside a row that already belongs to a sheet (the new-account draft), so it keeps its label but
 * draws no second sheet.
 */
export function ConnectedAccountFormSection(props: Readonly<{
    embedded?: boolean;
    title?: string;
    description?: string;
    children: React.ReactNode;
}>): React.ReactElement {
    // In a contained flow (the Connect sheet) the form is the flow's own bare section: its rows bleed by their
    // padding, so labels keep the column's edge with the steps above and the footer below.
    const contained = usePageListInsets() === 'contained';
    if (!props.embedded || contained) {
        return (
            <ItemGroup title={props.title} description={props.description} surface={contained ? 'none' : undefined}
                {...(contained && !props.title && !props.description ? { header: 'none' as const } : {})}>
                {props.children}
            </ItemGroup>
        );
    }
    return <EmbeddedFormSection {...props} />;
}

function EmbeddedFormSection(props: Readonly<{
    title?: string;
    description?: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const text = {
        ...Typography.variant('body'),
        paddingHorizontal: theme.space.s16,
    };
    return (
        <View style={{ paddingTop: theme.space.s8 }}>
            {props.title ? (
                <Text style={{ ...text, ...Typography.default('medium'), color: theme.colors.text.primary, paddingTop: theme.space.s4 }}>
                    {props.title}
                </Text>
            ) : null}
            {props.description ? (
                <Text style={{ ...text, color: theme.colors.text.secondary }}>{props.description}</Text>
            ) : null}
            {props.children}
        </View>
    );
}
