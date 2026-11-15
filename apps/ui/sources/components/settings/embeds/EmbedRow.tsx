import * as React from 'react';
import type { ApiTokenSettingsToken } from '@/components/settings/apiTokens/apiTokenSettingsController';

import { ApiTokenStatusGlyph } from '@/components/settings/apiTokens/ApiTokenStatusGlyph';
import { buildApiTokenRowPresentation, resolveApiTokenStatusLabel } from '@/components/settings/apiTokens/apiTokenSettingsPresentation';
import { collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { Item } from '@/components/ui/lists/Item';

import { listEmbedSummaryParts } from './embedDraft';
import { formatEmbedSummary, type EmbedSummaryNames } from './embedPresentation';

/**
 * One embed: its name, one line with only the facts that differ from the quiet defaults, and an
 * icon-only status only for an expiry that needs attention. The same row in the rail (compact, selected by route) and
 * on the list page (with a chevron).
 */
export const EmbedRow = React.memo(function EmbedRow(props: Readonly<{
    token: ApiTokenSettingsToken;
    names: EmbedSummaryNames;
    nowMs: number;
    variant: 'rail' | 'page';
    selected?: boolean;
    onPress: (token: ApiTokenSettingsToken) => void;
}>) {
    const presentation = buildApiTokenRowPresentation({ token: props.token, nowMs: props.nowMs });
    const summary = formatEmbedSummary(listEmbedSummaryParts(props.token), props.names);
    const statusLabel = resolveApiTokenStatusLabel(presentation);
    const rail = props.variant === 'rail';
    const { onPress, token } = props;
    const press = React.useCallback(() => onPress(token), [onPress, token]);
    return (
        <Item
            rowRole="catalogRow"
            testID={`settings-embeds-row:${props.token.tokenId}`}
            title={props.token.label}
            rightElement={statusLabel ? <ApiTokenStatusGlyph presentation={presentation} /> : undefined}
            subtitle={summary}
            accessibilityLabel={[props.token.label, statusLabel, summary].filter(Boolean).join(', ')}
            selected={rail ? props.selected === true : undefined}
            density={rail ? 'compact' : undefined}
            showChevron={!rail}
            pressableStyle={rail ? collectionListStyles.row : undefined}
            onPress={press}
        />
    );
});
