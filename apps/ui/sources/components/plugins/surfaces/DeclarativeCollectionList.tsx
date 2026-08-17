import * as React from 'react';

import { List as PluginUiList } from '@happier-dev/plugin-ui';
import {
    HappierInfoState,
    HappierInfoTile,
    HappierItemOverflow,
    HappierList,
    HappierListItem,
    HappierPressable,
    HappierText,
} from '@happier-dev/plugin-ui/presentation';
import type { HappierUiTheme } from '@happier-dev/plugin-ui/environment';
import {
    NormalizedPluginCollectionUiQueryDescriptorV1Schema,
    PluginCollectionUiQueryRequestV1Schema,
    PluginDeclarativeCollectionListProjectionV1Schema,
    type NormalizedPluginCollectionUiQueryDescriptorV1,
    type PluginCollectionUiQueryRequestV1,
    type PluginDeclarativeCollectionListProjectionV1,
} from '@happier-dev/protocol';
import type {
    PluginUiCollectionQueryPager,
    PluginUiCollectionQuerySnapshot,
    PluginUiDataClient,
} from '@happier-dev/plugin-ui/data';

import { Text } from '@/components/ui/text/Text';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';

type RecordValue = Readonly<Record<string, unknown>>;
type AccountLifetime = Readonly<{
    isCurrent(): boolean;
}>;

type CollectionListBinding = Readonly<{
    descriptor: NormalizedPluginCollectionUiQueryDescriptorV1;
    request: PluginCollectionUiQueryRequestV1;
    projection: PluginDeclarativeCollectionListProjectionV1;
}>;

type CollectionListPagerState = Readonly<{
    bindingKey: string;
    accountLifetime: AccountLifetime | null;
    dataClient: PluginUiDataClient | null;
    pager: PluginUiCollectionQueryPager | null;
    creationFailed: boolean;
}>;

type CollectionListRow = PluginUiCollectionQuerySnapshot['rows'][number];

/**
 * The only data a row command may receive. Data owns the row fields, query,
 * opaque cursor, Account lifetime and change subscription; a surface command
 * deliberately receives none of those implementation details.
 */
export type DeclarativeCollectionRowCommandContext =
    PluginUiCollectionQuerySnapshot['rows'][number]['context'];

export type DeclarativeCollectionRowCommandAffordance = Readonly<{
    id: string;
    label: string;
    icon?: React.ReactNode;
    disabled: boolean;
    busy?: boolean;
    /** Bound by the mounted surface owner after static catalog reattachment. */
    onPress?: () => void;
}>;

export type DeclarativeCollectionRowCommands = Readonly<{
    primary?: DeclarativeCollectionRowCommandAffordance;
    secondary: readonly DeclarativeCollectionRowCommandAffordance[];
}>;

export type DeclarativeCollectionRowCommandResolver = (
    context: DeclarativeCollectionRowCommandContext,
    /** Static normalized surface node; never Data-owned row fields or query state. */
    node: RecordValue,
) => DeclarativeCollectionRowCommands | null;

/**
 * A pure, opaque token for the command facts that can change for one row while
 * the mounted surface resolver remains otherwise stable.
 */
type DeclarativeCollectionRowCommandStateResolver = (
    context: DeclarativeCollectionRowCommandContext,
    node: RecordValue,
) => string | null;

const EMPTY_COLLECTION_LIST_PAGER_STATE: CollectionListPagerState = Object.freeze({
    bindingKey: '',
    accountLifetime: null,
    dataClient: null,
    pager: null,
    creationFailed: false,
});

const EMPTY_COLLECTION_LIST_PAGER_SNAPSHOT: PluginUiCollectionQuerySnapshot = Object.freeze({
    rows: Object.freeze([]),
    hasMore: false,
    status: 'idle',
});

function readRecord(value: unknown): RecordValue | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as RecordValue
        : null;
}

function isProjectedField(
    descriptor: NormalizedPluginCollectionUiQueryDescriptorV1,
    field: Readonly<{ field: string; kind: string }> | undefined,
): boolean {
    return field !== undefined && descriptor.projectedFields.some((candidate) => (
        candidate.field === field.field && candidate.kind === field.kind
    ));
}

/**
 * The static/dynamic model has already passed the neutral Protocol normalizer.
 * This is a narrow renderer-boundary reattachment check, not a second query
 * normalizer: it accepts only the exact Data descriptor projected into the
 * node and never reads a manifest, index, schema, or application store.
 */
function readCollectionListBinding(input: Readonly<{
    pluginId: string;
    node: RecordValue;
}>): CollectionListBinding | null {
    const source = readRecord(input.node.source);
    const descriptor = NormalizedPluginCollectionUiQueryDescriptorV1Schema.safeParse(input.node.query);
    const projection = PluginDeclarativeCollectionListProjectionV1Schema.safeParse(input.node.projection);
    if (!source || !descriptor.success || !projection.success) return null;

    const request = PluginCollectionUiQueryRequestV1Schema.safeParse({
        pluginId: input.pluginId,
        collectionId: source.collectionId,
        uiQueryId: source.uiQueryId,
        parameters: source.parameters,
    });
    if (
        !request.success
        || descriptor.data.collection.pluginId !== input.pluginId
        || descriptor.data.collection.collectionId !== request.data.collectionId
        || descriptor.data.id !== request.data.uiQueryId
    ) {
        return null;
    }

    const fields = [
        projection.data.titleField,
        projection.data.subtitleField,
        projection.data.detailField,
        projection.data.badgeField,
        projection.data.statusField,
    ];
    if (!fields.every((field) => field === undefined || isProjectedField(descriptor.data, field))) return null;

    return Object.freeze({
        descriptor: descriptor.data,
        request: request.data,
        projection: projection.data,
    });
}

function collectionListBindingKey(
    binding: CollectionListBinding,
    modelGeneration: string,
): string {
    const parameters = Object.entries(binding.request.parameters)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, value]) => [key, value]);
    const projection = [
        binding.projection.titleField,
        binding.projection.subtitleField,
        binding.projection.detailField,
        binding.projection.badgeField,
        binding.projection.statusField,
    ].map((field) => field ? [field.field, field.kind] : null);
    return JSON.stringify([
        modelGeneration,
        binding.descriptor.collection.pluginId,
        binding.descriptor.collection.collectionId,
        binding.descriptor.id,
        parameters,
        projection,
    ]);
}

function readProjectedScalar(
    fields: Readonly<Record<string, unknown>>,
    field: Readonly<{ field: string }> | undefined,
): string | null {
    if (!field) return null;
    const value = fields[field.field];
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? t('common.on') : t('common.off');
    return null;
}

type DeclarativeCollectionListRowProps = Readonly<{
    row: CollectionListRow;
    node: RecordValue;
    projection: PluginDeclarativeCollectionListProjectionV1 | undefined;
    path: string;
    presentationTheme: HappierUiTheme;
    minimumTouchTarget: number;
    resolveRowCommands?: DeclarativeCollectionRowCommandResolver;
    commandState: string | null;
}>;

function hasSameCollectionRowContext(left: CollectionListRow, right: CollectionListRow): boolean {
    return left.context.collection.pluginId === right.context.collection.pluginId
        && left.context.collection.collectionId === right.context.collection.collectionId
        && left.context.rowId === right.context.rowId
        && left.context.revision === right.context.revision;
}

function hasSameProjectedRowPresentation(
    left: CollectionListRow,
    right: CollectionListRow,
    projection: PluginDeclarativeCollectionListProjectionV1 | undefined,
): boolean {
    const fields = [
        projection?.titleField,
        projection?.subtitleField,
        projection?.detailField,
        projection?.badgeField,
        projection?.statusField,
    ];
    return fields.every((field) => (
        readProjectedScalar(left.fields, field) === readProjectedScalar(right.fields, field)
    ));
}

/**
 * Data snapshots intentionally freeze fresh row objects. The embedded branch
 * still maps its bounded page under the parent's scroll owner, so this is the
 * narrow static boundary that keeps unchanged row presentation and command
 * context from rebuilding their command/menu tree on every pager snapshot.
 * It owns no row cache or Data state: a changed projected value, static command
 * node, owner-projected command fact, theme, or resolver reference renders the
 * real row again.
 */
const DeclarativeCollectionListRow = React.memo(function DeclarativeCollectionListRow(
    props: DeclarativeCollectionListRowProps,
): React.ReactElement {
    const { row } = props;
    const title = readProjectedScalar(row.fields, props.projection?.titleField) ?? t('common.none');
    const subtitle = readProjectedScalar(row.fields, props.projection?.subtitleField);
    const detail = [
        readProjectedScalar(row.fields, props.projection?.detailField),
        readProjectedScalar(row.fields, props.projection?.badgeField),
        readProjectedScalar(row.fields, props.projection?.statusField),
    ].filter((value): value is string => value !== null).join(' · ');
    const commands = props.resolveRowCommands?.(row.context, props.node) ?? null;
    const primary = commands?.primary;
    const secondary = commands?.secondary ?? [];
    const overflow = secondary.length > 0 ? (
        <HappierItemOverflow
            testID={`plugin-declarative-collection-list:${props.path}:row:${row.context.rowId}:overflow`}
            actions={secondary.map((command) => ({
                id: command.id,
                label: command.label,
                disabled: command.disabled,
                icon: command.icon,
            }))}
            accessibilityLabel={t('common.more')}
            onSelect={(id) => secondary.find((command) => command.id === id)?.onPress?.()}
            renderMenu={(input) => (
                <DropdownMenu
                    testID={`plugin-declarative-collection-list:${props.path}:row:${row.context.rowId}:overflow-menu`}
                    open={input.open}
                    onOpenChange={input.onOpenChange}
                    trigger={({ toggle }) => (
                        <HappierPressable
                            testID={`plugin-declarative-collection-list:${props.path}:row:${row.context.rowId}:overflow-trigger`}
                            accessibilityRole="button"
                            accessibilityLabel={input.triggerAccessibilityLabel}
                            disabled={input.disabled}
                            onPress={toggle}
                            style={(state) => ({
                                minWidth: props.minimumTouchTarget,
                                minHeight: props.minimumTouchTarget,
                                justifyContent: 'center',
                                alignItems: 'center',
                                paddingHorizontal: props.presentationTheme.spacing.small,
                                borderRadius: props.presentationTheme.radii.control,
                                opacity: state.disabled ? 0.5 : state.pressed ? 0.8 : 1,
                            })}
                        >
                            <HappierText accessible={false} testID={input.testID}>
                                {input.trigger}
                            </HappierText>
                        </HappierPressable>
                    )}
                    items={input.actions.map((action) => ({
                        id: action.id,
                        title: action.label,
                        icon: action.icon,
                        disabled: action.disabled,
                    }))}
                    onSelect={input.onSelect}
                    matchTriggerWidth={false}
                    placement="bottom"
                />
            )}
        />
    ) : undefined;
    return (
        <HappierListItem
            testID={`plugin-declarative-collection-list:${props.path}:row:${row.context.rowId}`}
            title={title}
            subtitle={subtitle ?? undefined}
            detail={detail || undefined}
            icon={primary?.icon}
            onPress={primary?.onPress}
            disabled={primary?.disabled}
            busy={primary?.busy}
            accessory={overflow}
            accessoryOutsidePressable={overflow !== undefined}
            hasSecondaryActions={secondary.length > 0}
            theme={props.presentationTheme}
            minimumTouchTarget={props.minimumTouchTarget}
        />
    );
}, (previous, next) => (
    previous.node === next.node
    && previous.path === next.path
    && previous.projection === next.projection
    && previous.presentationTheme === next.presentationTheme
    && previous.minimumTouchTarget === next.minimumTouchTarget
    && previous.resolveRowCommands === next.resolveRowCommands
    && previous.commandState === next.commandState
    && hasSameCollectionRowContext(previous.row, next.row)
    && hasSameProjectedRowPresentation(previous.row, next.row, next.projection)
));

function renderNotice(input: Readonly<{
    kind: 'error' | 'unavailable';
    path: string;
    presentationTheme: HappierUiTheme;
    minimumTouchTarget: number;
    onRetry: () => void;
}>): React.ReactElement {
    const isError = input.kind === 'error';
    const color = isError ? input.presentationTheme.colors.danger : input.presentationTheme.colors.mutedText;
    const title = isError ? t('common.error') : t('common.unavailable');
    return (
        <HappierInfoState
            testID={`plugin-declarative-collection-list:${input.path}:${input.kind}`}
            accessibilityRole={isError ? 'alert' : undefined}
            accessibilityLiveRegion="polite"
            action={isError ? (
                <HappierPressable
                    testID={`plugin-declarative-collection-list:${input.path}:retry`}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.retry')}
                    onPress={input.onRetry}
                    style={(state) => ({
                        minWidth: input.minimumTouchTarget,
                        minHeight: input.minimumTouchTarget,
                        justifyContent: 'center',
                        alignItems: 'center',
                        paddingHorizontal: input.presentationTheme.spacing.medium,
                        borderRadius: input.presentationTheme.radii.control,
                        backgroundColor: input.presentationTheme.colors.accent,
                        opacity: state.disabled ? 0.5 : state.pressed ? 0.8 : 1,
                    })}
                >
                    <Text style={{ color: input.presentationTheme.colors.onAccent }}>{t('common.retry')}</Text>
                </HappierPressable>
            ) : undefined}
        >
            <HappierInfoTile
                title={<Text style={{ color }}>{title}</Text>}
            />
        </HappierInfoState>
    );
}

/**
 * Mounted presentation consumer for one already-admitted `DATA-UI-QUERY`.
 * The Data pager owns authenticated transport, Account currentness,
 * cancellation, result validation, opaque continuation, and LKG/change state.
 * This component owns only mount lifecycle and presentation of its snapshots.
 */
export function DeclarativeCollectionList(props: Readonly<{
    pluginId: string;
    /** Normalized model generation that owns this mounted query binding. */
    modelGeneration: string;
    node: RecordValue;
    accountLifetime: AccountLifetime | null;
    /** The mounted host's one captured-Account Data adapter. */
    dataClient?: PluginUiDataClient | null;
    presentationTheme: HappierUiTheme;
    minimumTouchTarget: number;
    /**
     * The mounted root surface delegated its sole scroll viewport to this
     * bounded collection. Embedded lists stay static inside their parent's
     * existing scroll owner, avoiding nested native virtualizers.
     */
    ownsScrollViewport?: boolean;
    /**
     * Presentation receives an already-admitted command resolver from the
     * mounted surface owner. It receives fixed row context plus this static
     * node, never row fields or an independent data query capability.
     */
    resolveRowCommands?: DeclarativeCollectionRowCommandResolver;
    /**
     * Owner-projected per-row command facts, such as pending Actions. This is
     * an opaque token rather than another pending-state owner.
     */
    getRowCommandState?: DeclarativeCollectionRowCommandStateResolver;
}>): React.ReactElement {
    const binding = React.useMemo(() => (
        props.modelGeneration.trim().length > 0
            ? readCollectionListBinding({
                pluginId: props.pluginId,
                node: props.node,
            })
            : null
    ), [props.modelGeneration, props.node, props.pluginId]);
    const bindingKey = React.useMemo(
        () => binding ? collectionListBindingKey(binding, props.modelGeneration) : 'invalid',
        [binding, props.modelGeneration],
    );
    const path = typeof props.node.path === 'string' && props.node.path.trim().length > 0
        ? props.node.path
        : 'root';
    const [retry, setRetry] = React.useState(0);
    const [pagerState, setPagerState] = React.useState<CollectionListPagerState>(
        EMPTY_COLLECTION_LIST_PAGER_STATE,
    );
    const dataClient = props.dataClient ?? null;

    React.useEffect(() => {
        if (!binding || !dataClient || !props.accountLifetime || !props.accountLifetime.isCurrent()) {
            setPagerState((previous) => (
                previous.bindingKey === bindingKey && previous.accountLifetime === props.accountLifetime
                    && previous.dataClient === dataClient
                    && previous.pager === null && !previous.creationFailed
                    ? previous
                    : Object.freeze({
                        bindingKey,
                        accountLifetime: props.accountLifetime,
                        dataClient,
                        pager: null,
                        creationFailed: false,
                    })
            ));
            return;
        }

        let retired = false;
        let pager: PluginUiCollectionQueryPager | null = null;
        const controller = new AbortController();
        const accountLifetime = props.accountLifetime;
        void Promise.resolve()
            .then(() => dataClient.openCollectionQuery({
                collectionId: binding.request.collectionId,
                uiQueryId: binding.request.uiQueryId,
                parameters: binding.request.parameters,
                signal: controller.signal,
            }))
            .then(
                (openedPager) => {
                    pager = openedPager;
                    if (retired || controller.signal.aborted || !accountLifetime.isCurrent()) {
                        openedPager.dispose();
                        return;
                    }
                    setPagerState(Object.freeze({
                        bindingKey,
                        accountLifetime,
                        dataClient,
                        pager: openedPager,
                        creationFailed: false,
                    }));
                },
                () => {
                    if (retired || controller.signal.aborted || !accountLifetime.isCurrent()) return;
                    // Opening is Data-owned. The renderer exposes failure and
                    // retry only; it never adds a local query, watch, cursor,
                    // cache, or fallback client.
                    setPagerState(Object.freeze({
                        bindingKey,
                        accountLifetime,
                        dataClient,
                        pager: null,
                        creationFailed: true,
                    }));
                },
            );

        return () => {
            retired = true;
            controller.abort();
            pager?.dispose();
        };
    // Host placement updates may reconstruct an equivalent normalized node.
    // `bindingKey` is the complete Data-query identity within one admitted
    // model generation. Candidate adoption changes the generation and retires
    // the predecessor pager before the successor query opens.
    }, [bindingKey, dataClient, props.accountLifetime, retry]);

    const pager = pagerState.bindingKey === bindingKey
        && pagerState.accountLifetime === props.accountLifetime
        && pagerState.dataClient === dataClient
        ? pagerState.pager
        : null;
    const subscribePager = React.useCallback(
        (listener: () => void) => pager ? pager.subscribe(listener) : () => {},
        [pager],
    );
    const getPagerSnapshot = React.useCallback(
        () => pager?.getSnapshot() ?? EMPTY_COLLECTION_LIST_PAGER_SNAPSHOT,
        [pager],
    );
    const pagerSnapshot = React.useSyncExternalStore(
        subscribePager,
        getPagerSnapshot,
        getPagerSnapshot,
    );
    const pagerCurrent = pagerState.bindingKey === bindingKey
        && pagerState.accountLifetime === props.accountLifetime
        && pagerState.dataClient === dataClient;
    const currentPage = pagerCurrent && props.accountLifetime?.isCurrent() === true
        ? pagerSnapshot
        : null;
    const rows = currentPage?.rows ?? null;
    const unavailable = !binding
        || !dataClient
        || !props.accountLifetime
        || !props.accountLifetime.isCurrent()
        || currentPage?.status === 'unavailable';
    const failed = pagerCurrent && (pagerState.creationFailed || currentPage?.status === 'error');
    const retryQuery = React.useCallback(() => {
        if (pager) {
            void pager.refresh();
            return;
        }
        setRetry((value) => value + 1);
    }, [pager]);
    const loadMore = React.useCallback(() => {
        if (pager && currentPage?.status === 'ready' && currentPage.hasMore) {
            void pager.loadMore();
        }
    }, [currentPage, pager]);

    React.useEffect(() => {
        if (pager && pagerCurrent && props.accountLifetime?.isCurrent() === true) {
            // `useSyncExternalStore` has registered this presentation
            // subscriber before this effect runs. That closes the initial-read
            // race without making the UI another Data watcher or cursor owner.
            void pager.refresh();
        }
    }, [pager, pagerCurrent, props.accountLifetime]);

    const renderRow = React.useCallback((row: CollectionListRow) => (
        <DeclarativeCollectionListRow
            row={row}
            node={props.node}
            projection={binding?.projection}
            path={path}
            presentationTheme={props.presentationTheme}
            minimumTouchTarget={props.minimumTouchTarget}
            resolveRowCommands={props.resolveRowCommands}
            commandState={props.getRowCommandState?.(row.context, props.node) ?? null}
        />
    ), [
        binding?.projection,
        path,
        props.getRowCommandState,
        props.minimumTouchTarget,
        props.node,
        props.presentationTheme,
        props.resolveRowCommands,
    ]);
    const keyForRow = React.useCallback(
        (row: PluginUiCollectionQuerySnapshot['rows'][number]) => row.context.rowId,
        [],
    );

    if (rows && rows.length > 0) {
        const footer = (
            <>
                {currentPage?.status === 'ready' && currentPage.hasMore ? (
                    <HappierPressable
                        testID={`plugin-declarative-collection-list:${path}:load-more`}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.more')}
                        onPress={loadMore}
                        style={(state) => ({
                            minWidth: props.minimumTouchTarget,
                            minHeight: props.minimumTouchTarget,
                            justifyContent: 'center',
                            alignItems: 'center',
                            paddingHorizontal: props.presentationTheme.spacing.medium,
                            borderRadius: props.presentationTheme.radii.control,
                            backgroundColor: props.presentationTheme.colors.accent,
                            opacity: state.disabled ? 0.5 : state.pressed ? 0.8 : 1,
                        })}
                    >
                        <Text style={{ color: props.presentationTheme.colors.onAccent }}>{t('common.more')}</Text>
                    </HappierPressable>
                ) : null}
                {failed ? renderNotice({
                    kind: 'error',
                    path,
                    presentationTheme: props.presentationTheme,
                    minimumTouchTarget: props.minimumTouchTarget,
                    onRetry: retryQuery,
                }) : null}
                {unavailable ? renderNotice({
                    kind: 'unavailable',
                    path,
                    presentationTheme: props.presentationTheme,
                    minimumTouchTarget: props.minimumTouchTarget,
                    onRetry: retryQuery,
                }) : null}
            </>
        );
        return (
            props.ownsScrollViewport ? (
                <PluginUiList
                    items={rows}
                    keyForItem={keyForRow}
                    renderItem={renderRow}
                    testID={`plugin-declarative-collection-list:${path}`}
                    style={{ flex: 1, minWidth: 0 }}
                    footer={footer}
                />
            ) : (
                <>
                    <HappierList testID={`plugin-declarative-collection-list:${path}`} style={{ gap: 8 }}>
                        {rows.map((row) => (
                            <React.Fragment key={keyForRow(row)}>
                                {renderRow(row)}
                            </React.Fragment>
                        ))}
                    </HappierList>
                    {footer}
                </>
            )
        );
    }

    if (unavailable) {
        return renderNotice({
            kind: 'unavailable',
            path,
            presentationTheme: props.presentationTheme,
            minimumTouchTarget: props.minimumTouchTarget,
            onRetry: retryQuery,
        });
    }
    if (failed) {
        return renderNotice({
            kind: 'error',
            path,
            presentationTheme: props.presentationTheme,
            minimumTouchTarget: props.minimumTouchTarget,
            onRetry: retryQuery,
        });
    }
    if (currentPage?.status === 'ready' && rows && rows.length === 0) {
        return (
            <HappierInfoState
                testID={`plugin-declarative-collection-list:${path}:empty`}
                accessibilityLiveRegion="polite"
            >
                <HappierInfoTile
                    title={<Text style={{ color: props.presentationTheme.colors.mutedText }}>{t('common.noMatches')}</Text>}
                />
            </HappierInfoState>
        );
    }
    return (
        <HappierInfoState
            testID={`plugin-declarative-collection-list:${path}:loading`}
            accessibilityLiveRegion="polite"
            busy
        >
            <HappierInfoTile
                title={<Text style={{ color: props.presentationTheme.colors.mutedText }}>{t('common.loading')}</Text>}
            />
        </HappierInfoState>
    );
}
