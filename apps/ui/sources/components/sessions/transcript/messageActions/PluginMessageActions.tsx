import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type {
    MessageActionReferenceV1,
} from '@happier-dev/protocol';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { openPluginContributedAction } from '@/components/plugins/actions/openPluginContributedAction';
import { resolvePluginContributedActionIconName } from '@/components/plugins/actions/pluginContributedActionPresentation';
import {
    comparePluginContributedActionDescriptors,
    createPluginContributedActionController,
    type PluginContributedActionCurrentSnapshot,
    type PluginContributedActionDescriptor,
} from '@/components/plugins/actions/pluginContributedActionController';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

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
    onPress: (action: PluginContributedActionDescriptor) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    return (
        <Pressable
            testID={`plugin-message-action:${props.action.qualifiedActionId}`}
            accessibilityRole="button"
            accessibilityLabel={props.action.title}
            onPress={() => props.onPress(props.action)}
            style={({ pressed }) => [
                styles.button,
                Platform.OS === 'web' ? styles.buttonWeb : null,
                props.invertedActionsLayout ? styles.buttonInverted : null,
                {
                    minHeight: minimumInteractiveTargetSize,
                    minWidth: minimumInteractiveTargetSize,
                },
                pressed ? styles.buttonPressed : null,
            ]}
        >
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
 * The incumbent DropdownMenu owns keyboard, screen-reader, touch, and
 * responsive overflow behavior. This adapter contributes only already-admitted
 * message Actions and sends their selection back through the shared controller.
 */
function PluginMessageActionOverflow(props: Readonly<{
    actions: readonly PluginContributedActionDescriptor[];
    invertedActionsLayout: boolean;
    onPress: (action: PluginContributedActionDescriptor) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const items = React.useMemo((): readonly DropdownMenuItem[] => props.actions.map((action) => ({
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
    const handleSelect = React.useCallback((qualifiedActionId: string) => {
        setOpen(false);
        const action = props.actions.find((candidate) => candidate.qualifiedActionId === qualifiedActionId);
        if (action) props.onPress(action);
    }, [props.actions, props.onPress]);

    return (
        <DropdownMenu
            testID="plugin-message-actions-overflow-menu"
            open={open}
            onOpenChange={setOpen}
            items={items}
            onSelect={handleSelect}
            placement="bottom"
            popoverAnchorAlign="end"
            variant="slim"
            matchTriggerWidth={false}
            maxWidthCap={260}
            showCategoryTitles={false}
            trigger={({ toggle }) => (
                <Pressable
                    testID="plugin-message-actions-overflow"
                    accessibilityRole="button"
                    accessibilityLabel={t('common.moreActions')}
                    accessibilityHint={t('common.moreActionsHint')}
                    onPress={toggle}
                    style={({ pressed }) => [
                        styles.overflowButton,
                        props.invertedActionsLayout ? styles.overflowButtonInverted : null,
                        {
                            minHeight: minimumInteractiveTargetSize,
                            minWidth: minimumInteractiveTargetSize,
                        },
                        pressed ? styles.buttonPressed : null,
                    ]}
                >
                    <Icon name="dots-three" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                </Pressable>
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
export function PluginMessageActions(props: Readonly<{
    invertedActionsLayout: boolean;
    messageActionReference?: MessageActionReferenceV1;
}>): React.ReactElement | null {
    const host = React.useContext(PluginMessageActionHostContext);
    const controller = React.useMemo(() => {
        if (!host || !props.messageActionReference) return null;
        return createPluginContributedActionController({
            resolveCurrent: () => host.resolveCurrent(props.messageActionReference!),
        });
    }, [host, props.messageActionReference]);
    const rowActions = orderMessageActions(
        controller?.list({ placement: 'rowAction', scope: 'message' }) ?? [],
    );
    const overflowActions = orderMessageActions(
        controller?.list({ placement: 'contextMenu', scope: 'message' }) ?? [],
    );
    const semanticMenuActions = orderMessageActions(
        controller?.list({ placement: 'message.menu', scope: 'message' }) ?? [],
    );
    const mergedOverflowActions = mergeOverflowMessageActions({
        legacy: overflowActions,
        semantic: semanticMenuActions,
    });
    const openAction = React.useCallback((action: PluginContributedActionDescriptor) => {
        if (!controller) return;
        fireAndForget(openPluginContributedAction({
            controller,
            action,
            ...(host?.signal ? { signal: host.signal } : {}),
        }), { tag: 'PluginMessageActions.openAction' });
    }, [controller, host?.signal]);

    if (rowActions.length === 0 && mergedOverflowActions.length === 0) return null;
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
            {mergedOverflowActions.length > 0 ? (
                <PluginMessageActionOverflow
                    actions={mergedOverflowActions}
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
        gap: 4,
        maxWidth: 180,
        paddingHorizontal: 6,
        borderRadius: 6,
        marginRight: 6,
        cursor: 'pointer',
    },
    buttonWeb: {
        paddingVertical: 6,
    },
    buttonInverted: {
        marginRight: 2,
    },
    overflowButton: {
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 6,
        marginRight: 6,
        cursor: 'pointer',
    },
    overflowButtonInverted: {
        marginRight: 2,
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
