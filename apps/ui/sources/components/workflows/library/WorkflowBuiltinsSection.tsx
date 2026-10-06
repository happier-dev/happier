import * as React from 'react';
import { getBuiltinWorkflowCatalogV1, type BuiltinWorkflowCatalogEntryV1, type BuiltinWorkflowPurposeV1 } from '@happier-dev/protocol';
import { countWorkflowStepsV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { openSessionGoalControl } from '@/components/sessions/workState/openSessionGoalControl';
import { resolveSessionRoutePathForSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t, tLoose } from '@/text';
import { useWorkflowExistingSessionOptions } from '../screens/useWorkflowExistingSessionOptions';

/** Each built-in's mark says what it is for (lab `nav-N1`: a shield, a list, a target). */
export const BUILTIN_WORKFLOW_PURPOSE_GLYPHS = {
    goal: 'target',
    review: 'shield-check',
    plan: 'list-checks',
    pull_request: 'git-pull-request',
} as const satisfies Record<BuiltinWorkflowPurposeV1, IconName>;

/** Built-in rows are projections of Protocol's catalog, never Account library records. */
export function WorkflowBuiltinsSection(): React.ReactElement {
    return <ItemGroup title={t('workflows.page.blocks.builtin')} description={t('workflows.examples.builtInDescription')}>
        {getBuiltinWorkflowCatalogV1().map((entry) => <BuiltinRow key={entry.id} entry={entry} />)}
    </ItemGroup>;
}

function BuiltinRow({ entry, showDivider }: Readonly<{ entry: BuiltinWorkflowCatalogEntryV1; showDivider?: boolean }>) {
    const router = useRouter();
    // "{n} steps" and the description only (04 §3.3, F15): a built-in's runs carry no library key for a strip.
    const subtitle = [tLoose(entry.descriptionKey), t('workflows.examples.stepCount', { count: countWorkflowStepsV1(entry.definition.blocks) })].join(' · ');
    return <Item testID={`workflow-builtins:${entry.id}`} title={tLoose(entry.titleKey)} subtitle={subtitle} showDivider={showDivider}
        icon={<Icon name={BUILTIN_WORKFLOW_PURPOSE_GLYPHS[entry.purpose]} />}
        onPress={() => router.push(createWorkflowDefinitionRoute(entry.id) as never)}
        rightElement={entry.requiresOriginSession
            ? <WorkflowBuiltinSessionButton entry={entry} testID={`workflow-builtins:${entry.id}:session`} />
            : <RoundButton testID={`workflow-builtins:${entry.id}:run`} size="small" display="inverted"
                title={t('workflows.destination.rowMenu.runNow')} onPress={() => router.push(`${createWorkflowDefinitionRoute(entry.id)}?intent=run` as never)} />} />;
}

/** Uses the same Session candidacy and Home identity as continuation and trigger pickers. */
export function WorkflowBuiltinSessionButton(props: Readonly<{ entry: BuiltinWorkflowCatalogEntryV1; testID?: string }>) {
    const router = useRouter();
    const scope = useActiveServerAccountScope();
    const [open, setOpen] = React.useState(false);
    const { existingSessions } = useWorkflowExistingSessionOptions({ serverId: scope?.serverId ?? null, machineId: null });
    return <DropdownMenu open={open} onOpenChange={setOpen} search
        items={(scope === null ? [] : existingSessions).map((session) => ({ id: session.sessionId, title: session.label }))}
        trigger={({ toggle }) => <RoundButton testID={props.testID} size="small" display="inverted" title={t('workflows.examples.chooseSession')} onPress={toggle} />}
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
