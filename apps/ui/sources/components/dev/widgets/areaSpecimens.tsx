import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { PluginUiWidgetAreaOperationV1, PluginUiWidgetAreaResultV1 } from '@happier-dev/protocol/plugins/ui';
import {
    applyWidgetAreaLayoutIntentV1, flattenWidgetLayoutWidgetsV1, type WidgetAreaLayoutIntentV1, type WidgetAreaLayoutV1, type WidgetLayoutWidgetV1, type WidgetInstanceV1, type WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { WidgetArea } from '@/components/widgets/area/WidgetArea';
import { pluginPageWidgetContext } from '@/components/widgets/area/PluginPageWidgetArea';
import { ProjectAsideWidgets, ProjectWidgetArea, projectWidgetAreaContext } from '@/components/widgets/area/ProjectWidgetArea';
import type { WidgetAreaPort } from '@/components/widgets/area/useWidgetAreaLayout';
import { t } from '@/text';

import type { WidgetSpecimenFrames } from './widgetSpecimenTypes';

/**
 * Dev-only fixtures for widget areas (lab `dashboards` PG/PGp, P1/P1p/P1a): the real area owner, frames,
 * gallery and Set up over a local area port that applies the Protocol's own area reducer. The
 * specimen identity is a dev surface, not an Account Artifact; nothing here persists.
 */

const SCOPE = { serverId: 'specimen', accountId: 'specimen' } as const;
const SUMMARY: WidgetInstanceV1['definition'] = { kind: 'builtin', id: 'session_summary' };
const CHANGES: WidgetInstanceV1['definition'] = { kind: 'builtin', id: 'changes' };

/** A specimen area port: the Protocol reducer over in-memory layout, answered like the host port. */
function useSpecimenAreaPort(surface: WidgetSurfaceRefV1, initial: readonly Omit<WidgetLayoutWidgetV1, 'kind'>[]): WidgetAreaPort {
    const layout = React.useRef<WidgetAreaLayoutV1>({ v: 1, surface, items: initial.map(item => ({ kind: 'widget', ...item })) });
    return React.useMemo<WidgetAreaPort>(() => ({
        execute: async (operation: PluginUiWidgetAreaOperationV1): Promise<PluginUiWidgetAreaResultV1> => {
            const ref = (instanceId: string) => ({ surface, instanceId });
            const apply = (intent: WidgetAreaLayoutIntentV1, instanceId: string): PluginUiWidgetAreaResultV1 => {
                try {
                    layout.current = applyWidgetAreaLayoutIntentV1(layout.current, intent);
                } catch (error) {
                    const code = error instanceof Error ? error.message : 'widget_area_unavailable';
                    return { ok: false, errorCode: code, error: code };
                }
                return { ok: true, result: { ref: ref(instanceId), instance: flattenWidgetLayoutWidgetsV1(layout.current.items).find(entry => entry.instance.id === instanceId)?.instance ?? null } };
            };
            switch (operation.actionId) {
                case 'widgets.item.list': return { ok: true, result: { surface, items: layout.current.items, instances: flattenWidgetLayoutWidgetsV1(layout.current.items), canEdit: true } };
                case 'widgets.item.add': return apply({ kind: 'add', instance: operation.instance,
                    ...(operation.size ? { size: operation.size } : {}) }, operation.instance.id);
                case 'widgets.item.remove': return apply({ kind: 'remove', instanceId: operation.instanceId }, operation.instanceId);
                case 'widgets.item.move': return apply({ kind: 'move', instanceId: operation.instanceId, toIndex: operation.toIndex }, operation.instanceId);
                case 'widgets.item.rename': return apply({ kind: 'rename', instanceId: operation.instanceId, displayName: operation.displayName }, operation.instanceId);
                case 'widgets.item.size.set':
                    return apply('size' in operation
                        ? { kind: 'size', instanceId: operation.instanceId, size: operation.size }
                        : { kind: 'width', instanceId: operation.instanceId, width: operation.width }, operation.instanceId);
                case 'widgets.item.frame.set': return apply({ kind: 'frame', instanceId: operation.instanceId, frameStyle: operation.frameStyle }, operation.instanceId);
                case 'widgets.item.inputs.set': return apply({ kind: 'inputs', instanceId: operation.instanceId, bindings: operation.bindings }, operation.instanceId);
                default: return { ok: false, errorCode: 'unsupported_method', error: 'unsupported_method' };
            }
        },
    }), [surface]);
}

const PAGE_SURFACE: WidgetSurfaceRefV1 = { ...SCOPE, owner: { kind: 'pluginArea', pluginId: 'specimen.prs', pageId: 'overview', area: 'pinned' } };
const PROJECT_SURFACE: WidgetSurfaceRefV1 = { ...SCOPE, owner: { kind: 'project', projectId: 'specimen-project' } };

function PluginPageAreaSpecimen(props: Readonly<{ phone: boolean }>): React.ReactElement {
    const port = useSpecimenAreaPort(PAGE_SURFACE, [
        { instance: { v: 1, id: 'summary', definition: SUMMARY, bindings: {} }, size: 'medium' },
        { instance: { v: 1, id: 'changes', definition: CHANGES, bindings: {} }, size: 'medium' },
    ]);
    const context = React.useMemo(() => pluginPageWidgetContext({ repository: 'happier' }), []);
    return (
        <View style={[styles.page, props.phone ? styles.phone : styles.desk]}>
            <Text style={styles.pageTitle}>PRs &amp; Issues</Text>
            <WidgetArea port={port} context={context} geometry="grid" title={t('widgetAdd.areaPinned')}
                meta={t('widgetAdd.areaPinnedMeta')} surfaceName="PRs & Issues" testID="specimen-plugin-area" />
        </View>
    );
}

function ProjectAsideSpecimen(props: Readonly<{ phone: boolean }>): React.ReactElement {
    const port = useSpecimenAreaPort(PROJECT_SURFACE, [
        { instance: { v: 1, id: 'summary', definition: SUMMARY, bindings: {} } },
        { instance: { v: 1, id: 'changes', definition: CHANGES, bindings: {} } },
    ]);
    // Lane-12-shaped facts: a portable source for "This project" and the chip's exact checkout.
    const context = React.useMemo(() => projectWidgetAreaContext({
        project: { value: { repository: 'happier-dev/happier' }, label: 'happier-dev/happier' },
        checkout: { value: { checkout: 'macbook-main' }, label: 'MacBook Pro · main' },
    }), []);
    const area = <ProjectWidgetArea projectName="happier" port={port} context={context} testID="specimen-project-area" />;
    if (!props.phone) return <View style={[styles.page, styles.aside]}>{area}</View>;
    // Phone: the block sits under the checkout row, above Code (lab P1p).
    return (
        <View style={[styles.page, styles.phone]}>
            <View style={styles.checkoutRow}><Text style={styles.checkout}>MacBook Pro · main</Text></View>
            {area}
        </View>
    );
}

function ProjectUnavailableSpecimen(props: Readonly<{ phone: boolean }>): React.ReactElement {
    return (
        <View style={[styles.page, props.phone ? styles.phone : styles.aside]}>
            <ProjectAsideWidgets serverId="specimen" projectName="happier" testID="specimen-project-unavailable" />
        </View>
    );
}

export const AREA_SPECIMEN_FRAMES: WidgetSpecimenFrames = {
    PG: ({ phone }) => <PluginPageAreaSpecimen phone={phone} />,
    P1: ({ phone }) => <ProjectAsideSpecimen phone={phone} />,
    P1u: ({ phone }) => <ProjectUnavailableSpecimen phone={phone} />,
};

const styles = StyleSheet.create((theme) => ({
    page: { backgroundColor: theme.colors.background.canvas, padding: 16, gap: 16 },
    desk: { width: 1040 },
    aside: { width: 360 },
    phone: { width: 390 },
    pageTitle: { ...Typography.default('semiBold'), ...happierPageTextMetrics('pageTitle'), color: theme.colors.text.primary },
    checkoutRow: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border.default },
    checkout: { ...Typography.default('semiBold'), color: theme.colors.text.primary },
}));
