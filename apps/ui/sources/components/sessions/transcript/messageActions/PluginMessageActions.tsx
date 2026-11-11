import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    MessageActionReferenceV1,
} from '@happier-dev/protocol/sessions/messages/messageActionReferenceV1';

import type { PopoverAnchor } from '@/components/ui/popover';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { DropdownMenu, type DropdownMenuItem, type DropdownMenuSelection } from '@/components/ui/forms/dropdown/DropdownMenu';
import { openPluginContributedAction } from '@/components/plugins/actions/openPluginContributedAction';
import { resolvePluginContributedActionIconName } from '@/components/plugins/actions/pluginContributedActionPresentation';
import {
    comparePluginContributedActionDescriptors,
    createPluginContributedActionController,
    type PluginContributedActionCurrentSnapshot,
    type PluginContributedActionDescriptor,
} from '@/components/plugins/actions/pluginContributedActionController';
import {
    usePluginUiClientExecutableRegistrationRevision,
} from '@/components/plugins/reactNative/clientExecutableContributions';
import { useMessageActionHitArea } from './useMessageActionHitArea';
import { MessageActionIconButton } from './MessageActionIconButton';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { createPluginLocalizedTextResolver, usePluginLocalizedTextResolver, type PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';

/**
 * The transcript root owns the current projection and intent facts. A row adds
 * only its opaque Message-owned reference before the generic Action controller
 * re-resolves the target at press time.
 */
export type PluginMessageActionHost = Readonly<{
    resolveCurrent: (
        messageActionReference: MessageActionReferenceV1,
    ) => PluginContributedActionCurrentSnapshot | null;
    signal?: AbortSignal;
}>;

const PluginMessageActionHostContext = React.createContext<PluginMessageActionHost | null>(null);

/**
 * Binds an already-current transcript Action host to exactly one mounted
 * Session. The opaque reference stays Message-owned; this adapter merely
 * prevents a fork/read-only row from borrowing the current Session's Action
 * transport before the daemon performs its own current lookup.
 */
export function createPluginMessageActionHost(params: Readonly<{
    resolveCurrent: () => PluginContributedActionCurrentSnapshot | null;
    sessionId: string;
    signal?: AbortSignal;
}>): PluginMessageActionHost {
    return {
        ...(params.signal ? { signal: params.signal } : {}),
        resolveCurrent(messageActionReference) {
            if (messageActionReference.sessionId !== params.sessionId) return null;
            const current = params.resolveCurrent();
            if (current?.host.sessionId !== params.sessionId) return null;
            return {
                ...current,
                host: {
                    ...current.host,
                    ...(params.signal ? { signal: params.signal } : {}),
                    messageActionReference,
                    isCurrent: () => current.host.isCurrent?.() !== false,
                },
            };
        },
    };
}

export function PluginMessageActionHostProvider(props: Readonly<{
    children: React.ReactNode;
    host: PluginMessageActionHost | null;
}>): React.ReactElement {
    return (
        <PluginMessageActionHostContext.Provider value={props.host}>
            {props.children}
        </PluginMessageActionHostContext.Provider>
    );
}

/**
 * The transcript-specific adapter is intentionally context-only: consumers
 * still use the shared contributed-Action controller for currentness,
 * availability, forms, and canonical dispatch.
 */
export function usePluginMessageActionHost(): PluginMessageActionHost | null {
    return React.useContext(PluginMessageActionHostContext);
}

/**
 * An immutable structured transcript snapshot carries its own historical
 * label/input, but its qualified Action reference remains a live capability.
 * This adapter supplies only the opaque current Message reference to the
 * generic Action owner. It never invents mounted provenance, resolves a
 * structured-message descriptor, or substitutes a current Action identity.
 */
export function createPluginPersistedStructuredMessageActionController(params: Readonly<{
    host: PluginMessageActionHost | null;
    messageActionReference?: MessageActionReferenceV1;
}>) {
    if (!params.host || !params.messageActionReference) return null;
    return createPluginContributedActionController({
        resolveCurrent: () => params.host!.resolveCurrent(params.messageActionReference!),
    });
}

function PluginMessageActionButton(props: Readonly<{
    action: PluginContributedActionDescriptor;
    invertedActionsLayout: boolean;
    onPress: (action: PluginContributedActionDescriptor, anchor?: PopoverAnchor) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const hitArea = useMessageActionHitArea(props.invertedActionsLayout);
    return (
        <Pressable
            testID={`plugin-message-action:${props.action.qualifiedActionId}`}
            hitSlop={hitArea.hitSlop}
            onLayout={hitArea.onLayout}
            accessibilityRole="button"
            accessibilityLabel={props.action.title}
            onPress={(event) => props.onPress(props.action, resolvePressTriggerAnchor(event))}
            style={({ pressed }) => [
                styles.button,
                props.invertedActionsLayout ? styles.buttonInverted : null,
                pressed ? styles.buttonPressed : null,
            ]}
        >
            {hitArea.frame}
            <Icon
                name={resolvePluginContributedActionIconName(props.action.icon)}
                size={ICON_SIZE.xs}
                color={theme.colors.text.secondary}
            />
            <Text numberOfLines={1} style={styles.buttonLabel}>{props.action.title}</Text>
        </Pressable>
    );
}

/**
 * The row's one ⋯ (owner 05): the host's own overflow actions first, then the already-admitted plugin message
 * Actions. The incumbent DropdownMenu owns keyboard, screen-reader, touch, and responsive overflow behavior; a
 * plugin selection goes back through the shared controller, a host one to the host.
 */
function MessageActionOverflow(props: Readonly<{
    actions: readonly PluginContributedActionDescriptor[];
    hostItems: readonly DropdownMenuItem[];
    onSelectHost: (id: string) => void;
    anchorRef?: React.Ref<View>;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    invertedActionsLayout: boolean;
    onPress: (action: PluginContributedActionDescriptor, anchor?: PopoverAnchor) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const pluginItems = React.useMemo((): readonly DropdownMenuItem[] => props.actions.map((action) => ({
        id: action.qualifiedActionId,
        testID: `plugin-message-action-menu:${action.qualifiedActionId}`,
        title: action.title,
        ...(action.description ? { subtitle: action.description } : {}),
        icon: (
            <Icon
                name={resolvePluginContributedActionIconName(action.icon)}
                size={ICON_SIZE.xs}
                color={theme.colors.text.secondary}
            />
        ),
    })), [props.actions, theme.colors.text.secondary]);
    const items = React.useMemo(() => [...props.hostItems, ...pluginItems], [pluginItems, props.hostItems]);
    const handleSelect = React.useCallback((id: string, selection?: DropdownMenuSelection) => {
        props.onOpenChange(false);
        const action = props.actions.find((candidate) => candidate.qualifiedActionId === id);
        if (action) props.onPress(action, selection?.anchor);
        else props.onSelectHost(id);
    }, [props.actions, props.onOpenChange, props.onPress, props.onSelectHost]);

    return (
        <DropdownMenu
            testID="plugin-message-actions-overflow-menu"
            open={props.open}
            onOpenChange={props.onOpenChange}
            items={items}
            onSelect={handleSelect}
            placement="bottom"
            popoverAnchorAlign="end"
            variant="slim"
            matchTriggerWidth={false}
            maxWidthCap={260}
            showCategoryTitles={false}
            trigger={({ toggle }) => (
                <MessageActionIconButton
                    testID="plugin-message-actions-overflow"
                    icon="dots-three"
                    accessibilityLabel={t('common.moreActions')}
                    accessibilityHint={t('common.moreActionsHint')}
                    hasPopup="menu"
                    expanded={props.open}
                    anchorRef={props.anchorRef}
                    invertedActionsLayout={props.invertedActionsLayout}
                    onPress={toggle}
                />
            )}
        />
    );
}

function orderMessageActions(
    actions: readonly PluginContributedActionDescriptor[],
): readonly PluginContributedActionDescriptor[] {
    return [...actions].sort(comparePluginContributedActionDescriptors);
}

/**
 * Legacy message overflow Actions retain their established no-arm route.
 * Semantic `message.menu` Actions are host-presented, but a mixed declaration
 * must keep its legacy descriptor rather than acquiring a second authority.
 */
function mergeOverflowMessageActions(params: Readonly<{
    legacy: readonly PluginContributedActionDescriptor[];
    semantic: readonly PluginContributedActionDescriptor[];
}>): readonly PluginContributedActionDescriptor[] {
    const uniqueByQualifiedId = new Map<string, PluginContributedActionDescriptor>();
    for (const action of [...params.legacy, ...params.semantic]) {
        if (!uniqueByQualifiedId.has(action.qualifiedActionId)) {
            uniqueByQualifiedId.set(action.qualifiedActionId, action);
        }
    }
    return orderMessageActions([...uniqueByQualifiedId.values()]);
}

/**
 * Projects legacy message row/overflow Actions plus semantic `message.menu`
 * Actions into the incumbent `MessageActionRow`. It owns neither catalog
 * admission nor Action dispatch: both remain in the shared contributed-Action
 * controller and its dispatcher.
 */
export function usePluginMessageActions(props: Readonly<{
    enabled: boolean;
    messageActionReference?: MessageActionReferenceV1;
    rowVisible?: boolean;
    menuVisible?: boolean;
}>) {
    usePluginUiClientExecutableRegistrationRevision();
    const host = React.useContext(PluginMessageActionHostContext);
    const current = props.enabled && props.messageActionReference ? host?.resolveCurrent(props.messageActionReference) : null;
    const localize = usePluginLocalizedTextResolver({ projection: current?.pluginUiProjection ?? null });
    const localizeRef = React.useRef(localize);
    localizeRef.current = localize;
    const localizeCurrent = React.useCallback<PluginLocalizedTextResolver>((pluginId, value) => localizeRef.current(pluginId, value), []);
    // Inventory keeps real labels and admission while hidden; only presented copy records Resource demand.
    const metadataLocalize = createPluginLocalizedTextResolver({ projection: current?.pluginUiProjection });
    const [overflowOpen, setOverflowOpen] = React.useState(false);
    const controller = React.useMemo(() => {
        if (!props.enabled || !host || !props.messageActionReference) return null;
        return createPluginContributedActionController({
            resolveCurrent: () => {
                const snapshot = host.resolveCurrent(props.messageActionReference!);
                return snapshot ? { ...snapshot, localize: localizeCurrent } : null;
            },
        });
    }, [props.enabled, host, props.messageActionReference, localizeCurrent]);
    const rowPresentation = { localize: props.rowVisible !== false || props.menuVisible === true ? localize : metadataLocalize };
    const menuPresentation = { localize: overflowOpen || props.menuVisible === true ? localize : metadataLocalize };
    const rowActions = orderMessageActions(
        controller?.list({ placement: 'rowAction', scope: 'message' }, rowPresentation) ?? [],
    );
    const overflowActions = orderMessageActions(
        controller?.list({ placement: 'contextMenu', scope: 'message' }, menuPresentation) ?? [],
    );
    const semanticMenuActions = orderMessageActions(
        controller?.list({ placement: 'message.menu', scope: 'message' }, menuPresentation) ?? [],
    );
    const mergedOverflowActions = mergeOverflowMessageActions({
        legacy: overflowActions,
        semantic: semanticMenuActions,
    });
    const openAction = React.useCallback((action: PluginContributedActionDescriptor, anchor?: PopoverAnchor) => {
        if (!controller) return;
        fireAndForget(openPluginContributedAction({
            controller,
            action,
            anchor,
            ...(host?.signal ? { signal: host.signal } : {}),
        }), { tag: 'PluginMessageActions.openAction' });
    }, [controller, host?.signal]);

    const menuActions = mergeOverflowMessageActions({ legacy: rowActions, semantic: mergedOverflowActions });
    return { rowActions, mergedOverflowActions, menuActions, openAction, overflowOpen, setOverflowOpen };
}

export function PluginMessageActions(props: Readonly<{
    invertedActionsLayout: boolean;
    messageActionReference?: MessageActionReferenceV1;
}>): React.ReactElement | null {
    const actions = usePluginMessageActions({ enabled: true, messageActionReference: props.messageActionReference });
    return <PluginMessageActionsView actions={actions} invertedActionsLayout={props.invertedActionsLayout} />;
}

const NO_HOST_ITEMS: readonly DropdownMenuItem[] = Object.freeze([]);
const noHostSelection = () => undefined;

export function PluginMessageActionsView(props: Readonly<{
    invertedActionsLayout: boolean;
    actions: ReturnType<typeof usePluginMessageActions>;
    /** The host's own overflow actions, listed first under the same ⋯. */
    hostOverflowItems?: readonly DropdownMenuItem[];
    onSelectHostOverflow?: (id: string) => void;
    /** Where a sheet opened from the ⋯ anchors. */
    overflowAnchorRef?: React.Ref<View>;
}>): React.ReactElement | null {
    const { rowActions, mergedOverflowActions, openAction, overflowOpen, setOverflowOpen } = props.actions;
    const hostItems = props.hostOverflowItems ?? NO_HOST_ITEMS;

    if (rowActions.length === 0 && mergedOverflowActions.length === 0 && hostItems.length === 0) return null;
    return (
        <View testID="plugin-message-actions" style={styles.container}>
            {rowActions.map((action) => (
                <PluginMessageActionButton
                    key={action.qualifiedActionId}
                    action={action}
                    invertedActionsLayout={props.invertedActionsLayout}
                    onPress={openAction}
                />
            ))}
            {mergedOverflowActions.length > 0 || hostItems.length > 0 ? (
                <MessageActionOverflow
                    actions={mergedOverflowActions}
                    hostItems={hostItems}
                    onSelectHost={props.onSelectHostOverflow ?? noHostSelection}
                    anchorRef={props.overflowAnchorRef}
                    open={overflowOpen}
                    onOpenChange={setOverflowOpen}
                    invertedActionsLayout={props.invertedActionsLayout}
                    onPress={openAction}
                />
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    button: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.s4,
        maxWidth: 180,
        paddingHorizontal: theme.space.s6,
        paddingVertical: theme.space.s6,
        borderRadius: 6,
        marginRight: theme.space.s6,
        cursor: 'pointer',
    },
    buttonInverted: {
        marginRight: theme.space.s2,
    },
    buttonPressed: {
        backgroundColor: theme.colors.state.neutral.background,
    },
    buttonLabel: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
        flexShrink: 1,
    },
}));
