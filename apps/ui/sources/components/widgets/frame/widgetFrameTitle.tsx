import * as React from 'react';
import { View } from 'react-native';
import type { WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { HappierSkeletonBlock, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAppShellPluginUiProjection, type AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { resolveWidgetInstanceTitle } from '@/components/widgets/widgetCatalog';
import type { MountedWidgetDefinitionV1 } from '@/sync/domains/widgets/useWidgetDefinition';

const selectTitleFacts = (value: AppShellPluginUiProjectionValue) =>
    ({ pluginUiProjection: value.pluginUiProjection, phase: value.phase });

/** Frame presentation over the title owner; the mounted body's existing read supplies its outcome. */
export function useWidgetFrameTitle(instance: WidgetInstanceV1, candidate: Readonly<{ title: string }> | null | undefined): Readonly<{
    title: string | React.ReactElement;
    onDefinitionRead: (state: MountedWidgetDefinitionV1['state']) => void;
}> {
    const { pluginUiProjection, phase } = useAppShellPluginUiProjection(selectTitleFacts);
    const [read, setRead] = React.useState<Readonly<{ reference: WidgetInstanceV1['definition']; state: MountedWidgetDefinitionV1['state'] }> | null>(null);
    const onDefinitionRead = React.useCallback((state: MountedWidgetDefinitionV1['state']) => {
        setRead({ reference: instance.definition, state });
    }, [instance.definition]);
    const title = resolveWidgetInstanceTitle(instance, candidate, {
        definitionState: read?.reference === instance.definition ? read.state : 'loading',
        pluginUiProjection, projectionPending: phase === 'establishing',
    });
    return { title: title ?? <WidgetFrameTitleSkeleton />, onDefinitionRead };
}

/** The header's title line while the name is not known yet: it keeps the title's room, so arrival moves nothing. */
export function WidgetFrameTitleSkeleton(): React.ReactElement {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    return (
        <View accessible role="status" accessibilityLabel={t('common.loading')} style={styles.line}>
            <HappierSkeletonBlock width={96} height={10} radius={5} color={theme.colors.surface.skeleton} reducedMotion={reducedMotion} />
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    line: { justifyContent: 'center', height: happierPageTextMetrics('sectionTitle').lineHeight },
}));
