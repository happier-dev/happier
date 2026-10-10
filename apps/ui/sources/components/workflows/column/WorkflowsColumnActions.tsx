import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { NewAccountTriggerPopover } from '@/components/workflows/triggers/AccountTriggersSection';
import { t } from '@/text';
import { WorkflowExamplesPopover } from '../library/WorkflowExamplesPopover';
import { useWorkflowAgentAuthoring } from '../authoring/useWorkflowAgentAuthoring';
import { buildWorkflowAgentAuthoringSeed } from '@/sync/domains/workflows/workflowAgentAuthoringSeed';

/** Where each "+" choice goes; the editor owns what happens next. */
export const WORKFLOWS_NEW_ROUTE = '/workflows/new';
export const WORKFLOWS_IMPORT_ROUTE = '/workflows/new?importJson=1';
export const WORKFLOWS_RUN_SETTINGS_ROUTE = '/workflows/settings';

/**
 * The column header's two controls (lab `nav-N1m`, FIN 04 §3.3): `⋯` with the destination's run
 * settings, and "+", a menu because there is more than one way to add. Its choices are the ones whose
 * owners exist: a blank draft, an imported file and a new Account trigger (F1, offered also where
 * only Triggers are available, 04 §3.4), and the read-only example picker (08). Create with an agent
 * is supplied by the authoring owner (U-17).
 */
export const WorkflowsColumnActions = React.memo(function WorkflowsColumnActions(props: Readonly<{
    /** Workflows can be created here (not the Triggers-only configuration). */
    canCreate: boolean;
}>) {
    const router = useRouter();
    const openAgent = useWorkflowAgentAuthoring();
    const [addOpen, setAddOpen] = React.useState(false);
    const [moreOpen, setMoreOpen] = React.useState(false);
    const [newTriggerOpen, setNewTriggerOpen] = React.useState(false);
    const [examplesOpen, setExamplesOpen] = React.useState(false);
    const addAnchorRef = React.useRef<View>(null);

    const newTriggerItem: DropdownMenuItem = {
        id: 'trigger',
        testID: 'workflows-column:add:trigger',
        title: t('workflows.triggers.column.newTrigger'),
        subtitle: t('workflows.triggers.column.newTriggerSubtitle'),
        icon: <Icon name="lightning" />,
    };
    const workflowItems: readonly DropdownMenuItem[] = [
        {
            id: 'new',
            testID: 'workflows-column:add:new',
            title: t('workflows.newWorkflow'),
            subtitle: t('workflows.destination.addMenu.newWorkflowSubtitle'),
            icon: <Icon name="plus" />,
        },
        { id: 'agent', testID: 'workflows-column:add:agent', title: t('workflows.authoring.create'),
            subtitle: t('workflows.authoring.description'), icon: <Icon name="sparkle" /> },
        newTriggerItem,
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
    const addItems: readonly DropdownMenuItem[] = props.canCreate ? workflowItems : [newTriggerItem];
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
                onSelect={(id) => {
                    setMoreOpen(false);
                    if (id === 'trigger') { setNewTriggerOpen(true); return; }
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
                    onSelect={(id) => {
                        setAddOpen(false);
                        if (id === 'trigger') { setNewTriggerOpen(true); return; }
                        if (id === 'example') { setExamplesOpen(true); return; }
                        if (id === 'agent') { openAgent(buildWorkflowAgentAuthoringSeed({ kind: 'create' })); return; }
                        router.push((id === 'import' ? WORKFLOWS_IMPORT_ROUTE : WORKFLOWS_NEW_ROUTE) as never);
                    }}
                    placement="bottom"
                    popoverAnchorAlign="end"
                    matchTriggerWidth={false}
                    maxWidthCap={320}
                    popoverPortalWebTarget="body"
                    trigger={({ toggle }) => (
                        <IconButton
                            testID="workflows-column:add"
                            iconName="plus"
                            accessibilityLabel={t('workflows.destination.addAccessibility')}
                            tooltip={t('workflows.destination.addAccessibility')}
                            variant="plain"
                            onPress={toggle}
                        />
                    )}
                />
            </View> : null}
            {newTriggerOpen ? (
                <NewAccountTriggerPopover anchorRef={addAnchorRef} onRequestClose={() => setNewTriggerOpen(false)} />
            ) : null}
            {examplesOpen ? <WorkflowExamplesPopover anchorRef={addAnchorRef} onRequestClose={() => setExamplesOpen(false)} /> : null}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
    },
}));
