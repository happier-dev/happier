import * as React from 'react';
import { HappierPageLoadingRows } from '@happier-dev/plugin-ui/presentation';
import { useUnistyles } from 'react-native-unistyles';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { PageFrame } from './PageFrame';
import { PageHeaderPlaceholder } from './PageHeader';

const renderFrame: NonNullable<React.ComponentProps<typeof HappierPageLoadingRows>['renderFrame']> = (input) => <PageFrame {...input} content="column" />;

/** Bind core's existing page column, navigation header and loading copy to the shared presentation. */
export const PageLoadingRows = React.memo(function PageLoadingRows(props: Readonly<{ testID: string; header?: boolean }>) {
    const { theme } = useUnistyles();
    const pluginTheme = usePluginUiTheme(theme);
    const reducedMotion = useReducedMotionPreference();
    return <HappierPageLoadingRows testID={props.testID} loadingLabel={t('common.loading')}
        header={props.header ? <PageHeaderPlaceholder testID={`${props.testID}-header`} /> : null}
        theme={pluginTheme} color={theme.colors.surface.skeleton} reducedMotion={reducedMotion} renderFrame={renderFrame} />;
});
