import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';
import { WorkflowExamplesPopover } from '../library/WorkflowExamplesPopover';
import { useWorkflowAgentAuthoring } from '../authoring/useWorkflowAgentAuthoring';
import { WorkflowSentenceBuilder } from '../sentence/WorkflowSentenceBuilder';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { buildWorkflowAgentAuthoringSeed } from '@/sync/domains/workflows/workflowAgentAuthoringSeed';
import { WORKFLOWS_IMPORT_ROUTE, WORKFLOWS_NEW_ROUTE, WORKFLOWS_RUN_SETTINGS_ROUTE } from '../workflowsRoutes';

/**
 * The column exposes each existing start directly (lab N1m); each editor owns its next step.
 */
export const WorkflowsColumnActions = React.memo(function WorkflowsColumnActions(props: Readonly<{
    /** This surface owns saved-Workflow creation. */
    canCreate: boolean;
    /** Receives the add menu's opener, so the phone bar's "+" opens the same menu as this "+". */
    addOpenerRef?: React.MutableRefObject<(() => void) | null>;
    /** The phone's floating "+" opens the add menu, so the head draws no second "+". */
    barOwnsAdd?: boolean;
}>) {
    const router = useRouter();
    const openAgent = useWorkflowAgentAuthoring();
    const [addOpen, setAddOpen] = React.useState(false);
    const [moreOpen, setMoreOpen] = React.useState(false);
    const [examplesOpen, setExamplesOpen] = React.useState(false);
    const addAnchorRef = React.useRef<View>(null);
    const addOpenerRef = props.addOpenerRef;
    const canCreate = props.canCreate;
    // New automation opens the sentence builder (D10); its Add another step… continues in the editor.
    const [builder, setBuilder] = React.useState<Readonly<{ lifetime: ServerAccountScopeLifetime; key: number }> | null>(null);
    const openTrigger = () => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) return;
        setBuilder((current) => ({ lifetime, key: (current?.key ?? 0) + 1 }));
    };
    useCurrentUiContextLocalCommands([{
        key: 'new-automation', title: t('workflows.triggers.editor.title'), invoke: openTrigger,
    }]);
    React.useEffect(() => {
        if (!addOpenerRef || !canCreate) return;
        addOpenerRef.current = () => setAddOpen(true);
        return () => { addOpenerRef.current = null; };
    }, [addOpenerRef, canCreate]);

    const newTriggerItem: DropdownMenuItem = {
        id: 'trigger',
        testID: 'workflows-column:add:trigger',
        title: t('workflows.triggers.editor.title'),
        subtitle: t('workflows.triggers.column.newTriggerSubtitle'),
        icon: <Icon name="lightning" />,
    };
    const workflowItems: readonly DropdownMenuItem[] = [
        {
            id: 'blank',
            testID: 'workflows-column:add:blank',
            title: t('workflows.newWorkflow'),
            subtitle: t('workflows.destination.addMenu.newWorkflowSubtitle'),
            icon: <Icon name="plus" />,
        },
        { id: 'agent', testID: 'workflows-column:add:agent', title: t('workflows.authoring.create'),
            subtitle: t('workflows.authoring.description'), icon: <Icon name="sparkle" /> },
        { id: 'example', testID: 'workflows-column:add:example', title: t('workflows.examples.fromExample'),
            subtitle: t('workflows.examples.description'), icon: <Icon name="tree-structure" /> },
        {
            id: 'import',
            testID: 'workflows-column:add:import',
            title: t('workflows.destination.import'),
            subtitle: t('workflows.destination.addMenu.importSubtitle'),
            icon: <Icon name="download" />,
        },
    ];
    const addItems: readonly DropdownMenuItem[] = [workflowItems[0]!, newTriggerItem, ...workflowItems.slice(1)];
    const moreItems: readonly DropdownMenuItem[] = [
        ...(!props.canCreate ? [newTriggerItem] : []),
        {
            id: 'settings',
            testID: 'workflows-column:more:settings',
            title: t('workflows.destination.runSettings'),
            icon: <Icon name="gear" />,
        },
    ];

    return (
        <View ref={addAnchorRef} collapsable={false} style={styles.row}>
            <DropdownMenu
                testID="workflows-column:more:menu"
                open={moreOpen}
                onOpenChange={setMoreOpen}
                items={moreItems}
                rowKind="item"
                itemRowProps={CREATION_MENU_ROW_PROPS}
                onSelect={(id) => {
                    setMoreOpen(false);
                    if (id === 'trigger') { openTrigger(); return; }
                    router.push(WORKFLOWS_RUN_SETTINGS_ROUTE as never);
                }}
                placement="bottom"
                popoverAnchorAlign="end"
                matchTriggerWidth={false}
                maxWidthCap={280}
                popoverPortalWebTarget="body"
                trigger={({ toggle }) => (
                    <IconButton
                        testID="workflows-column:more"
                        iconName="dots-three"
                        accessibilityLabel={t('workflows.destination.moreAccessibility')}
                        tooltip={t('workflows.destination.moreAccessibility')}
                        variant="plain"
                        interactiveTargetEdgesPx={BAND_EDGES}
                        onPress={toggle}
                    />
                )}
            />
            {props.canCreate ? <View>
                <DropdownMenu
                    testID="workflows-column:add:menu"
                    open={addOpen}
                    onOpenChange={setAddOpen}
                    items={addItems}
                    rowKind="item"
                    itemRowProps={CREATION_MENU_ROW_PROPS}
                    onSelect={(id) => {
                        setAddOpen(false);
                        if (id === 'trigger') { openTrigger(); return; }
                        if (id === 'example') { setExamplesOpen(true); return; }
                        if (id === 'agent') { openAgent(buildWorkflowAgentAuthoringSeed({ kind: 'create' })); return; }
                        router.pushRetainingCurrent((id === 'import' ? WORKFLOWS_IMPORT_ROUTE : WORKFLOWS_NEW_ROUTE) as never);
                    }}
                    placement="bottom"
                    popoverAnchorAlign="end"
                    matchTriggerWidth={false}
                    maxWidthCap={320}
                    popoverPortalWebTarget="body"
                    popoverPhonePresentation={props.barOwnsAdd ? 'sheet' : undefined}
                    // On a phone the floating bar's "+" is the one way to add (scene 8 phone, fix 8): the menu keeps a bare anchor.
                    trigger={({ toggle }) => props.barOwnsAdd ? <View testID="workflows-column:add" collapsable={false} /> : (
                        <IconButton
                            testID="workflows-column:add"
                            iconName="plus"
                            accessibilityLabel={t('workflows.destination.addAccessibility')}
                            tooltip={t('workflows.destination.addAccessibility')}
                            variant="plain"
                            interactiveTargetEdgesPx={BAND_EDGES}
                            onPress={toggle}
                        />
                    )}
                />
            </View> : null}
            {examplesOpen ? <WorkflowExamplesPopover anchorRef={addAnchorRef} onRequestClose={() => setExamplesOpen(false)} /> : null}
            {builder === null ? null : (
                <WorkflowSentenceBuilder key={builder.key} anchorRef={addAnchorRef} accountLifetime={builder.lifetime}
                    intent={{ name: t('workflows.newWorkflow') }} onRequestClose={() => setBuilder(null)} />
            )}
        </View>
    );
});

/**
 * The two header buttons sit flush, so their hit areas reach only above and below, and below only into the
 * band's own padding: the title block starts right after it and paints over anything further.
 */
const BAND_EDGES = { leading: 0, trailing: 0, bottom: HAPPIER_COLLECTION_LIST_METRICS.groupLabelFirstPaddingTop } as const;
const CREATION_MENU_ROW_PROPS = { subtitleLines: 2 } as const;

const styles = StyleSheet.create(() => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
    },
}));
