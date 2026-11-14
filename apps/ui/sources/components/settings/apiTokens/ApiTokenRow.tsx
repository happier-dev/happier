import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

import { ApiTokenStatusGlyph } from './ApiTokenStatusGlyph';
import type { ApiTokenSettingsToken } from './apiTokenSettingsController';
import {
    buildApiTokenAccessSummaryParts,
    buildApiTokenRowPresentation,
    formatApiTokenAccessSummary,
    resolveApiTokenStatusLabel,
    type ApiTokenAccessSummaryNames,
} from './apiTokenSettingsPresentation';

/**
 * One token in the collection: its label, an icon-only status only for an expiry that needs attention, and its access
 * in one line (an embed-backed token leads it with its kind). The same row in the rail (compact, selected by route) and
 * on the list page (with a chevron).
 */
export const ApiTokenRow = React.memo(function ApiTokenRow(props: Readonly<{
    token: ApiTokenSettingsToken;
    names: ApiTokenAccessSummaryNames;
    nowMs: number;
    variant: 'rail' | 'page';
    selected?: boolean;
    disabled?: boolean;
    onPress: (token: ApiTokenSettingsToken) => void;
}>) {
    const { theme } = useUnistyles();
    const presentation = buildApiTokenRowPresentation({ token: props.token, nowMs: props.nowMs });
    const summary = formatApiTokenAccessSummary(buildApiTokenAccessSummaryParts({
        token: props.token,
        nowMs: props.nowMs,
        names: props.names,
    }));
    const statusLabel = resolveApiTokenStatusLabel(presentation);
    const rail = props.variant === 'rail';
    const { onPress, token } = props;
    const press = React.useCallback(() => onPress(token), [onPress, token]);

    return (
        <Item
            rowRole="catalogRow"
            testID={`settings-api-tokens-row:${props.token.tokenId}`}
            title={props.token.label}
            titleStyle={presentation.status === 'expired' ? { color: theme.colors.text.secondary } : undefined}
            rightElement={statusLabel ? (
                <ApiTokenStatusGlyph testID={`settings-api-tokens-status:${props.token.tokenId}`} presentation={presentation} />
            ) : undefined}
            subtitle={presentation.embedBacked ? [t('settingsApiTokens.embedPill'), summary].filter(Boolean).join(' · ') : summary}
            accessibilityLabel={t('settingsApiTokens.rowAccessibilityLabel', {
                label: props.token.label,
                state: [statusLabel ?? t('settingsApiTokens.status.active'), summary].join(', '),
            })}
            accessibilityHint={presentation.embedBacked ? t('settingsApiTokens.embedRowHint') : undefined}
            selected={rail ? props.selected === true : undefined}
            density={rail ? 'compact' : undefined}
            showChevron={!rail}
            pressableStyle={rail ? collectionListStyles.row : undefined}
            disabled={props.disabled}
            onPress={press}
        />
    );
});
