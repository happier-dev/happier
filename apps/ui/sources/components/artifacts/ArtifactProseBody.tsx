import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/** Empty prose keeps the same body slot, including its surrounding passage-thread presentation. */
export function ArtifactProseBody(props: React.ComponentProps<typeof MarkdownView>) {
    return props.markdown === ''
        ? <Text style={styles.noContent}>{t('artifacts.noContent')}</Text>
        : <MarkdownView {...props} />;
}

const styles = StyleSheet.create((theme) => ({
    noContent: { fontSize: 14, color: theme.colors.text.tertiary },
}));
