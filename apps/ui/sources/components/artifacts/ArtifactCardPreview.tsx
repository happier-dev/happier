import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierArtifactPreviewCard, type HappierArtifactPreviewCardHost } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { describeBoardSources } from '@/components/boards/model/boardSourcePresentation';
import { ARTIFACT_KIND_ICONS } from './artifactKindPresentation';
import type { ArtifactBrowserKind, ArtifactPreview } from './artifactBrowserModel';

const renderText: HappierArtifactPreviewCardHost['renderText'] = ({ text, style, numberOfLines, typography }) => <Text numberOfLines={numberOfLines}
    useDefaultTypography={typography !== 'mono'}
    style={[typography === 'semiBold' ? Typography.default('semiBold') : typography === 'mono' ? Typography.mono() : null, style]}>{text}</Text>;

/** Host typography, kind policy and labels bind the shared, subscription-free preview. */
export const ArtifactCardPreview = React.memo(function ArtifactCardPreview(props: Readonly<{
    preview: ArtifactPreview;
    kind: ArtifactBrowserKind;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const { primary, secondary, tertiary } = theme.colors.text;
    const paper = theme.colors.surface.base;
    const paperBorder = theme.colors.border.default;
    const colors = React.useMemo(() => ({ primary, secondary, tertiary, paper, paperBorder }), [primary, secondary, tertiary, paper, paperBorder]);
    const layout = props.preview.kind === 'board' ? t(`boards.header.${props.preview.layout.mode === 'canvas' ? 'canvas' : 'byStatus'}`) : undefined;
    const sources = props.preview.kind === 'board' ? describeBoardSources(props.preview.layout.source) : '';
    const widgetCount = props.preview.kind === 'board' ? t('sessionBoard.sidebar.widgetCount', { count: props.preview.layout.widgets.length }) : '';
    const widget = t('boards.widgets.kind');
    const widthOne = t('boards.widgets.widthOne');
    const widthTwo = t('boards.widgets.widthTwo');
    const boardLabels = React.useMemo(() => layout === undefined ? undefined : ({ layout, sources, widgetCount, widget, widthOne, widthTwo }),
        [layout, sources, widgetCount, widget, widthOne, widthTwo]);
    const fallbackIcon = ARTIFACT_KIND_ICONS[props.kind];
    const host = React.useMemo<HappierArtifactPreviewCardHost>(() => ({ renderText,
        renderIcon: ({ name, size, color }) => <Icon name={name === 'fallback' ? fallbackIcon : name} size={size} color={color} />,
    }), [fallbackIcon]);
    return <HappierArtifactPreviewCard preview={props.preview} testID={props.testID}
        colors={colors}
        htmlLabel={t('artifacts.browser.kindOne.document')}
        fileDetail={props.preview.kind === 'file' ? `${props.preview.mime} · ${formatByteSize(props.preview.sizeBytes)}` : undefined}
        boardLabels={boardLabels} host={host} />;
});
