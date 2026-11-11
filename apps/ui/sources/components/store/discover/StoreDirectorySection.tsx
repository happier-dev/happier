import * as React from 'react';
import { Collection, type CollectionAnatomy, type CollectionGroupAction, useHappierCollection } from '@happier-dev/plugin-ui';

import { RegistryShelfAddControl } from '@/components/capabilities/add/RegistryShelf';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { retainDeep, retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { t } from '@/text';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useStoreRegistryIdentity } from '../catalog/StoreRegistryIdentity';

import { directoryKeyOf } from '../StoreKindPage';
import { useStoreListingSelection } from '../StoreListing';
import { StoreItemMark, storeMarkFactsOfReference } from '../catalog/StoreItemMark';
import { useMcpAdded, useSkillAdded, useAgentAdded, useProviderAdded } from '../catalog/storeAdded';
import type { StoreDiscoverItem, StoreDiscoverKind } from './storeDiscoverModel';

/** The catalog row's mark box draws a bare logo at this size inside it (S10 catalogRow; the kind pages' size). */
const ROW_MARK_PX = 26;
/** The page is the scroller: the directory's Collection draws none of its own. */
const passThroughScroller = (children: React.ReactNode) => children;

/** The kind word on a mixed list's title line ("Playwright  MCP server"). */
export function storeKindWord(kind: StoreDiscoverKind): string {
    switch (kind) {
        case 'app': return t('capabilities.store.kindWord.app');
        case 'browserExtension': return t('capabilities.store.kindWord.browserExtension');
        case 'mcpServer': return t('capabilities.store.kindWord.mcpServer');
        case 'skill': return t('capabilities.store.kindWord.skill');
        case 'agent': return t('capabilities.store.kindWord.agent');
        case 'provider': return t('capabilities.store.kindWord.provider');
        case 'plugin': return t('capabilities.store.kindWord.plugin');
        case 'software': return t('capabilities.store.kinds.software.title');
        case 'starter': return t('capabilities.store.kindWord.starter');
    }
}

/** Consume the page's admitted summary; a mark never acquires an item's install payload. */
export function StoreDiscoverItemMark(props: Readonly<{ item: StoreDiscoverItem; size?: number }>): React.ReactElement {
    const reference = props.item.reference;
    const selected = useStoreRegistryIdentity(reference);
    const facts = selected
        ? { kind: props.item.kind, title: selected.title, brand: selected.brandMark }
        : storeMarkFactsOfReference(props.item.kind, props.item.title, reference);
    return <StoreItemMark facts={facts}
        size={props.size ?? ROW_MARK_PX} />;
}

export type StoreDirectorySectionInput = Readonly<{
    key: string;
    /** Absent for a page whose header already names the section. */
    title: string | null;
    description?: string | null;
    items: readonly StoreDiscoverItem[];
    all?: Readonly<{ label: string; onPress: () => void }> | null;
}>;

/** The item as the directory draws it: its group, and whether the Account already holds it (a fact of the row, not of the page). */
type Row = StoreDiscoverItem & Readonly<{ group: string; added: boolean }>;
const keyOf = (row: Row) => `${row.group}|${row.key}`;
const groupOfRow = (row: Row) => row.group;

/**
 * The directory's rows. A row keeps its identity until its own item, group or added state changes, so an Added
 * inventory arriving (mcp, skill, agent, provider each load on their own) re-renders only the rows it changed.
 */
export function useDirectoryRows(
    sections: readonly StoreDirectorySectionInput[],
    isAdded: (item: StoreDiscoverItem) => boolean,
): readonly Row[] {
    const held = React.useRef<readonly Row[] | undefined>(undefined);
    return React.useMemo(() => {
        held.current = retainKeyedRows(held.current, sections.flatMap(section => section.items.map((item): Row =>
            ({ ...item, group: section.key, added: isAdded(item) }))), keyOf, { freeze: false });
        return held.current;
    }, [sections, isAdded]);
}

/**
 * Discover's directories (Happier picks, categories, a job's groups): the same Collection list the kind pages use —
 * catalog rows in two row-major columns on a wide page, one column when a row would not fit — with each section's
 * title, description and "All ›". A row opens the item's listing (`onOpen`: the pane beside the page, or its own page on
 * a phone) and the + is its own target, the kind's Add owner (`onAdd`). The row whose listing the pane shows reads selected.
 */
export const StoreDirectory = React.memo(function StoreDirectory(props: Readonly<{
    testID: string;
    accessibilityLabel: string;
    sections: readonly StoreDirectorySectionInput[];
    /** Mixed-kind lists name each row's kind; a single-kind list does not repeat it. */
    showKind: boolean;
    onOpen: (item: StoreDiscoverItem) => void;
    onAdd: (item: StoreDiscoverItem) => void;
}>) {
    const { sections, onOpen, onAdd, showKind, testID } = props;
    const focused = useOptionalScreenIsFocused() !== false;
    const visible = useLayoutPresentationActive();
    const presented = focused && visible;
    const held = (kind: StoreDiscoverKind) => sections.some(section => section.items.some(item => item.kind === kind));
    const mcpAdded = useMcpAdded(presented && held('mcpServer'));
    const skillAdded = useSkillAdded(presented && held('skill'));
    const agentAdded = useAgentAdded(presented && sections.some(section => section.items.some(item => item.reference.type === 'registryItem' && item.kind === 'agent')));
    const providerAdded = useProviderAdded(presented && held('provider'));
    const isAdded = React.useCallback((item: StoreDiscoverItem) => {
        const ref = item.reference;
        if (ref.type === 'providerContribution') return providerAdded(ref.contributionKey);
        if (ref.type !== 'registryItem') return false;
        const summary = { ...ref, title: item.title };
        switch (summary.kind) {
            case 'mcpServer': return mcpAdded(summary);
            case 'skill': return skillAdded(summary);
            case 'agent': return agentAdded(summary);
            default: return false;
        }
    }, [mcpAdded, skillAdded, agentAdded, providerAdded]);
    const rows = useDirectoryRows(sections, isAdded);
    const titled = sections.some(section => section.title !== null);
    // The page rebuilds its section inputs (and their callbacks) on every render: what the Collection reads is retained.
    const axisRef = React.useRef<readonly Readonly<{ key: string; title: string; description?: string }>[] | undefined>(undefined);
    const axis = axisRef.current = retainDeep(axisRef.current, sections.map(section => ({ key: section.key, title: section.title ?? '',
        ...(section.description ? { description: section.description } : {}) })));
    const groups = React.useMemo(() => titled ? { axis, groupOf: groupOfRow } : undefined, [axis, titled]);
    const onOpenChange = React.useCallback((key: string | null) => {
        const row = rows.find(candidate => keyOf(candidate) === key);
        if (row) onOpen(row);
    }, [onOpen, rows]);
    const selection = useStoreListingSelection();
    const selectedKey = React.useMemo(() => {
        const wanted = directoryKeyOf(selection);
        const row = wanted === null ? undefined : rows.find(candidate => directoryKeyOf(candidate.reference) === wanted);
        return row ? keyOf(row) : null;
    }, [rows, selection]);
    const model = useHappierCollection<Row>({ items: rows, keyOf, ...(groups ? { groups } : {}), openKey: selectedKey, onOpenChange });
    const latestSections = React.useRef(sections);
    latestSections.current = sections;
    const allLabels = sections.map(section => `${section.key}\u0000${section.all?.label ?? ''}`).join('\u0001');
    const groupAction = React.useMemo(() => (groupKey: string): CollectionGroupAction | null => {
        const all = latestSections.current.find(section => section.key === groupKey)?.all;
        return all ? { label: all.label, onPress: () => latestSections.current.find(section => section.key === groupKey)?.all?.onPress(), kind: 'link' } : null;
    }, [allLabels]);
    const anatomy = React.useMemo((): CollectionAnatomy<Row> => buildCapabilityCollectionAnatomy<Row>({
        title: row => row.title,
        description: row => row.description,
        ...(showKind ? { kindLabel: (row: Row) => storeKindWord(row.kind) } : {}),
        mark: row => <StoreDiscoverItemMark item={row} />,
        facts: () => ({}),
        action: row => row.reference.type === 'agentContribution' ? null : (
            <RegistryShelfAddControl
                testID={`${testID}.${row.id}.add`}
                state={row.added ? 'added' : 'available'}
                title={row.title}
                addLabel={t('capabilities.store.add')}
                addedLabel={t('capabilities.store.added')}
                failedLabel={t('capabilities.store.retry')}
                onAdd={() => onAdd(row)}
            />
        ),
        accessibilityLabel: row => row.title,
        testID: row => `${testID}.${row.id}`,
    }), [onAdd, showKind, testID]);
    if (rows.length === 0) return null;
    return (
        <CoreCollectionScope renderPageScroller={passThroughScroller}>
            <Collection<Row>
                testID={testID}
                model={model}
                anatomy={anatomy}
                accessibilityLabel={props.accessibilityLabel}
                presentation="list"
                detail="none"
                scroll="page"
                minListWidth={280}
                minDetailWidth={280}
                preferredListRatio={1}
                {...(groups ? { groupAction } : {})}
            />
        </CoreCollectionScope>
    );
});
