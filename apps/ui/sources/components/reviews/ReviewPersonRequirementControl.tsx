import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/** The same requested-person choice while starting a Review or editing its round. */
export function ReviewPersonRequirementControl(props: Readonly<{
    testID: string;
    name: string;
    required: boolean;
    disabled: boolean;
    onChange: (required: boolean) => void;
}>) {
    return <HappierPressable testID={props.testID} accessibilityRole="checkbox"
        accessibilityLabel={`${t('reviewWalkthrough.detail.required')}: ${props.name}`}
        checked={props.required} disabled={props.disabled}
        onPress={() => props.onChange(!props.required)} style={styles.control}>
        <SelectionCheckGlyph state={props.required ? 'checked' : 'unchecked'} size="compact" />
        <Text variant="meta">{t(props.required ? 'reviewWalkthrough.detail.required' : 'reviewWalkthrough.detail.optional')}</Text>
    </HappierPressable>;
}

const styles = StyleSheet.create(theme => ({
    control: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
