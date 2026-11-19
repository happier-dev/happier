import * as React from 'react';
import { View } from 'react-native';
import { getBuiltinWorkflowCatalogV1, type BuiltinWorkflowCatalogEntryV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
    HostCollection as Collection,
    useHappierCollection,
    type CollectionAnatomy,
} from '@happier-dev/plugin-ui';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { openSessionGoalControl } from '@/components/sessions/workState/openSessionGoalControl';
import { resolveSessionRoutePathForSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t, tLoose } from '@/text';
import { useWorkflowExistingSessionOptions } from '../screens/useWorkflowExistingSessionOptions';
import { resolveWorkflowSessionChoice, WORKFLOW_SESSION_RETRY_ITEM_ID, workflowSessionMenuState } from '../presentation/workflowSessionChoice';
import { workflowSessionOptionRow } from '../presentation/workflowSessionOptionRow';
import { WorkflowBuiltinMark } from '../presentation/WorkflowBuiltinMark';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';

type BuiltinRow = Readonly<{ key: string; entry: BuiltinWorkflowCatalogEntryV1 }>;

const BUILTIN_GROUPS = {
    get axis() {
        return [{ key: 'builtin', title: t('workflows.page.blocks.builtin'), description: t('workflows.examples.builtInDescription') }];
    },
    groupOf: () => 'builtin',
};
const readBuiltinKey = (row: BuiltinRow) => row.key;
const BUILTIN_MIN_WIDTH_PX = 320;
const COMPLETE = { kind: 'complete' as const };
const passThroughPageScroller = (children: React.ReactNode) => children;
const builtinTitle = (row: BuiltinRow) => tLoose(row.entry.titleKey);

/**
 * Built-in rows are projections of Protocol's catalog, never Account library records. They take the library's own
 * row anatomy from the same shared Collection (PHONE-ROWS-HUNT-1113): the purpose mark as the row's glyph, the name,
 * then "{n} steps · what it does". Run now and Choose a session… live on the built-in's own page, so a row carries
 * no action; pressing it opens that page.
 */
export function WorkflowBuiltinsSection(props: Readonly<{ isVisible?: (id: string) => boolean }> = {}): React.ReactElement | null {
    const router = useRouter();
    const { isVisible } = props;
    // On the library home the built-ins narrow with the Workflow space and search (R8-7); none left, no section.
    const rows = React.useMemo(() => getBuiltinWorkflowCatalogV1()
        .filter((entry) => isVisible?.(entry.id) ?? true)
        .map((entry): BuiltinRow => ({ key: entry.id, entry })), [isVisible]);
    const open = React.useCallback((key: string | null) => {
        if (key !== null) router.push(createWorkflowDefinitionRoute(key) as never);
    }, [router]);
    const model = useHappierCollection<BuiltinRow>({
        items: rows,
        keyOf: readBuiltinKey,
        groups: BUILTIN_GROUPS,
        window: COMPLETE,
        openKey: null,
        onOpenChange: open,
    });
    // The lab's Built-in section (scene 8, UI refinements ruling 18:23Z fix 4): its title and description on the page,
    // then compact two-column catalog rows (mark, name, what it does) each ending in "Start", never a second sheet.
    const anatomy = React.useMemo((): CollectionAnatomy<BuiltinRow> => ({
        rowRole: 'catalogRow',
        glyph: (row) => <WorkflowBuiltinMark icon={row.entry.icon} />,
        loadingGlyph: false,
        title: builtinTitle,
        description: (row) => tLoose(row.entry.descriptionKey),
        action: (row) => <RoundButton testID={`workflow-builtins:${row.entry.id}:start`} size="small" display="inverted"
            title={t('workflows.start.start')}
            onPress={() => router.push({ pathname: '/workflows/[id]', params: { id: row.entry.id, intent: 'run' } } as never)} />,
        accessibilityLabel: builtinTitle,
        testID: (row) => `workflow-builtins:${row.entry.id}`,
        columnTitles: { title: t('workflows.page.blocks.builtin') },
    }), [router]);
    if (rows.length === 0) return null;
    // Its own block and scope, as the examples' cards have: a Collection root fills its parent (flex 1, clipped), so
    // as a bare sibling of the library's Collection the two split the page column and the library's rows were cut short.
    return <View><CoreCollectionScope renderPageScroller={passThroughPageScroller}><Collection<BuiltinRow>
        testID="workflows-home:builtins"
        model={model}
        anatomy={anatomy}
        accessibilityLabel={t('workflows.page.blocks.builtin')}
        presentation="list"
        detail="none"
        scroll="page"
        minListWidth={BUILTIN_MIN_WIDTH_PX}
        minDetailWidth={BUILTIN_MIN_WIDTH_PX}
        preferredListRatio={1}
    /></CoreCollectionScope></View>;
}

/** Uses the same Session candidacy and Home identity as continuation and trigger pickers. */
export function WorkflowBuiltinSessionButton(props: Readonly<{ entry: BuiltinWorkflowCatalogEntryV1; testID?: string; primary?: boolean }>) {
    const router = useRouter();
    const focusedScope = useActiveServerAccountScope();
    const accountLifetime = useWorkflowAccountLifetime();
    const scope = accountLifetime === undefined ? focusedScope : accountLifetime?.scope;
    const [open, setOpen] = React.useState(false);
    const { existingSessions, sessionOptionsStatus, retrySessionOptions } = useWorkflowExistingSessionOptions({
        serverId: scope?.serverId ?? null, machineId: null, enabled: open });
    const sessions = scope === null ? [] : existingSessions;
    const menu = workflowSessionMenuState(resolveWorkflowSessionChoice(sessionOptionsStatus, sessions.length > 0),
        t('workflows.conversation.noSessionsYet'));
    return <DropdownMenu open={open} onOpenChange={setOpen} search searchPlaceholder={t('sessionsList.searchSessionsPlaceholder')}
        items={[...menu.leadingItems, ...sessions.map((session) => ({ id: session.sessionId, title: session.label, ...workflowSessionOptionRow(session) }))]}
        {...(menu.emptyLabel === undefined ? {} : { emptyLabel: menu.emptyLabel })}
        // Session names are long; the chooser takes the width they need, not the button's.
        matchTriggerWidth={false} popoverAccessibilityLabel={t('workflows.conversation.chooseExistingSession')}
        trigger={({ toggle }) => <RoundButton testID={props.testID} size="small" display={props.primary ? 'default' : 'secondary'} title={t('workflows.examples.chooseSession')} onPress={toggle} />}
        selectedId={null}
        closeOnSelect={false}
        onSelect={(sessionId) => {
            if (sessionId === WORKFLOW_SESSION_RETRY_ITEM_ID) { retrySessionOptions(); return; }
            if (!scope || accountLifetime === null || accountLifetime && !accountLifetime.isCurrent()
                || !existingSessions.some((session) => session.sessionId === sessionId)) return;
            setOpen(false);
            if (props.entry.id === 'builtin:keep-going') {
                openSessionGoalControl({ serverId: scope.serverId, sessionId });
                router.push(resolveSessionRoutePathForSurface(sessionId, 'chat', { serverId: scope.serverId }) as never);
            } else {
                router.push({ pathname: '/session/[id]/triggers', params: { id: sessionId, serverId: scope.serverId } } as never);
            }
        }} />;
}
