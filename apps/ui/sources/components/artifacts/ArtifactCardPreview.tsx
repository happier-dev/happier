import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierArtifactPreviewCard } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { ARTIFACT_KIND_ICONS } from './artifactKindPresentation';
import type { ArtifactBrowserKind, ArtifactPreview } from './artifactBrowserModel';

/** Host typography, kind policy and labels bind the shared, subscription-free preview. */
export const ArtifactCardPreview = React.memo(function ArtifactCardPreview(props: Readonly<{
    preview: ArtifactPreview;
    kind: ArtifactBrowserKind;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    return <HappierArtifactPreviewCard preview={props.preview} testID={props.testID}
        colors={{ ...theme.colors.text, paper: theme.colors.surface.base, paperBorder: theme.colors.border.default }}
        htmlLabel={t('artifacts.browser.kindOne.document')}
        fileDetail={props.preview.kind === 'file' ? `${props.preview.mime} · ${formatByteSize(props.preview.sizeBytes)}` : undefined}
        host={{
            renderText: ({ text, style, numberOfLines, typography }) => <Text numberOfLines={numberOfLines}
                useDefaultTypography={typography !== 'mono'}
                style={[typography === 'semiBold' ? Typography.default('semiBold') : typography === 'mono' ? Typography.mono() : null, style]}>{text}</Text>,
            renderIcon: ({ name, size, color }) => <Icon name={name === 'fallback' ? ARTIFACT_KIND_ICONS[props.kind] : name} size={size} color={color} />,
        }} />;
});
