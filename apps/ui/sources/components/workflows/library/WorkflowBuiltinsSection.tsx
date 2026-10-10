import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { getBuiltinWorkflowCatalogV1, type BuiltinWorkflowCatalogEntryV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { countWorkflowStepsV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { openSessionGoalControl } from '@/components/sessions/workState/openSessionGoalControl';
import { resolveSessionRoutePathForSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t, tLoose } from '@/text';
import { useWorkflowExistingSessionOptions } from '../screens/useWorkflowExistingSessionOptions';
import { WorkflowPurposeGlyph } from '../presentation/WorkflowPurposeGlyph';

const styles = StyleSheet.create({
    accessory: { alignSelf: 'flex-start', alignItems: 'flex-start' },
    intrinsicAction: { alignSelf: 'flex-start' },
});

/** Built-in rows are projections of Protocol's catalog, never Account library records. */
export function WorkflowBuiltinsSection(): React.ReactElement {
    const entries = getBuiltinWorkflowCatalogV1();
    const [actionWidths, setActionWidths] = React.useState<Readonly<Record<string, number>>>({});
    const measureAction = React.useCallback((id: string, width: number) => {
        setActionWidths(previous => previous[id] === width ? previous : { ...previous, [id]: width });
    }, []);
    const actionColumnWidth = Math.max(0, ...entries.map(entry => actionWidths[entry.id] ?? 0));
    return <ItemGroup title={t('workflows.page.blocks.builtin')} description={t('workflows.examples.builtInDescription')}>
        {entries.map((entry) => <BuiltinRow key={entry.id} entry={entry} actionColumnWidth={actionColumnWidth} measureAction={measureAction} />)}
    </ItemGroup>;
}

function BuiltinRow({ entry, showDivider, actionColumnWidth, measureAction }: Readonly<{
    entry: BuiltinWorkflowCatalogEntryV1;
    showDivider?: boolean;
    actionColumnWidth: number;
    measureAction(id: string, width: number): void;
}>) {
    const router = useRouter();
    // "{n} steps" and the description only (04 §3.3, F15): a built-in's runs carry no library key for a strip.
    const count = t('workflows.examples.stepCount', { count: countWorkflowStepsV1(entry.definition.blocks) });
    return <Item testID={`workflow-builtins:${entry.id}`} title={tLoose(entry.titleKey)} subtitle={tLoose(entry.descriptionKey)} detail={count}
        detailTestID={`workflow-builtins:${entry.id}:count`} showDivider={showDivider}
        icon={<WorkflowPurposeGlyph purpose={entry.purpose} />}
        onPress={() => router.push(createWorkflowDefinitionRoute(entry.id) as never)}
        rightElementOutsidePressable accessoryLayout="adaptive"
        rightElement={<View style={[styles.accessory, { minWidth: actionColumnWidth }]}>
            {/* Measure the intrinsic control, not the reserved column, so labels can grow and shrink. */}
            <View style={styles.intrinsicAction} onLayout={(event: LayoutChangeEvent) => measureAction(entry.id, event.nativeEvent.layout.width)}>{entry.requiresOriginSession
            ? <WorkflowBuiltinSessionButton entry={entry} testID={`workflow-builtins:${entry.id}:session`} />
            : <RoundButton testID={`workflow-builtins:${entry.id}:run`} size="small" display="secondary"
                title={t('workflows.destination.rowMenu.runNow')} onPress={() => router.push(`${createWorkflowDefinitionRoute(entry.id)}?intent=run` as never)} />}</View></View>} />;
}

/** Uses the same Session candidacy and Home identity as continuation and trigger pickers. */
export function WorkflowBuiltinSessionButton(props: Readonly<{ entry: BuiltinWorkflowCatalogEntryV1; testID?: string; primary?: boolean }>) {
    const router = useRouter();
    const scope = useActiveServerAccountScope();
    const [open, setOpen] = React.useState(false);
    const { existingSessions } = useWorkflowExistingSessionOptions({ serverId: scope?.serverId ?? null, machineId: null });
    return <DropdownMenu open={open} onOpenChange={setOpen} search
        items={(scope === null ? [] : existingSessions).map((session) => ({ id: session.sessionId, title: session.label }))}
        trigger={({ toggle }) => <RoundButton testID={props.testID} size="small" display={props.primary ? 'default' : 'secondary'} title={t('workflows.examples.chooseSession')} onPress={toggle} />}
        selectedId={null}
        onSelect={(sessionId) => {
            if (!scope || !existingSessions.some((session) => session.sessionId === sessionId)) return;
            setOpen(false);
            if (props.entry.id === 'builtin:keep-going') {
                openSessionGoalControl({ serverId: scope.serverId, sessionId });
                router.push(resolveSessionRoutePathForSurface(sessionId, 'chat', { serverId: scope.serverId }) as never);
            } else {
                router.push({ pathname: '/session/[id]/triggers', params: { id: sessionId, serverId: scope.serverId } } as never);
            }
        }} />;
}
