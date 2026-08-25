import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

import {
    PluginContributionIdentityV1Schema,
    buildQualifiedPluginContributionKey,
    type PluginContributionIdentityV1,
    type PluginDeclarativeNodeV2,
} from '@happier-dev/protocol';

import {
    readDeclarativeRecord,
    readDeclarativeText,
    renderDeclarativeNode,
    type DeclarativeActionAffordance,
} from '@/components/plugins/shared/declarativeNodes';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

export type StructuredMessageActionSelection = Readonly<{
    identity: PluginContributionIdentityV1;
    input?: unknown;
}>;

// This is disconnected host-private renderer prework, not a public transcript
// profile. Derive its dormant shape from the still-public declarative grammar
// rather than importing the withdrawn transcript-profile type through a
// Protocol subpath or recreating its schema locally.
type PrivateTranscriptPresentationNode = Exclude<
    PluginDeclarativeNodeV2,
    Readonly<{ kind: 'field' | 'collectionList' | 'targetedSurface' }>
>;

/**
 * Read the resolved action reference a declarative action node carries.
 *
 * The node carries BOTH a structured `identity` and its `qualifiedId`; the
 * identity is authoritative and the qualified key must agree with it, so a
 * resolution whose two spellings disagree is refused rather than dispatched.
 */
function readActionSelection(nodeAction: unknown): Readonly<{
    identity: PluginContributionIdentityV1;
    qualifiedId: string;
}> | null {
    const action = readDeclarativeRecord(nodeAction);
    const identity = PluginContributionIdentityV1Schema.safeParse(action?.identity ?? action);
    if (!identity.success) return null;
    const qualifiedId = buildQualifiedPluginContributionKey(identity.data);
    return action?.qualifiedId === undefined || action.qualifiedId === qualifiedId
        ? { identity: identity.data, qualifiedId }
        : null;
}

/**
 * The transcript projection of a declarative document.
 *
 * The node vocabulary itself is rendered by the single owner in
 * `@/components/plugins/shared/declarativeNodes`; this module supplies only the
 * two facts a transcript block owns differently from a mounted surface: an
 * action is dispatched through the block's `onAction` callback (and is not
 * offered at all when the block is not interactive). The persisted profile
 * excludes settings and Account Collection nodes; the empty callbacks below
 * preserve that rejection if corrupt data reaches this shared renderer.
 */
export function DeclarativeStructuredMessageRenderer(props: Readonly<{
    root: PrivateTranscriptPresentationNode;
    onAction?: (action: StructuredMessageActionSelection) => void;
    /**
     * An immutable transcript preserves the historical Action label and
     * placement, while this predicate overlays only the current capability
     * availability. It must not rewrite the node or resolve a live renderer.
     */
    isActionAvailable?: (action: StructuredMessageActionSelection) => boolean;
    actionPending?: boolean;
    /** Persisted rows retain disabled Actions so unavailable current runtime is not silently hidden. */
    showUnavailableActions?: boolean;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const {
        onAction,
        isActionAvailable,
        actionPending = false,
        showUnavailableActions = false,
    } = props;
    const minimumTouchTarget = resolveMinimumInteractiveTargetSize(Platform.OS);

    const resolveAction = React.useCallback((node: Readonly<Record<string, unknown>>): DeclarativeActionAffordance | null => {
        const selection = readActionSelection(node.action);
        if (selection === null) return null;
        if (onAction === undefined && !showUnavailableActions) return null;
        const currentActionAvailable = isActionAvailable?.(selection) ?? true;
        const enabled = onAction !== undefined
            && (showUnavailableActions ? node.enabled !== false : node.enabled === true)
            && currentActionAvailable
            && !actionPending;
        return {
            key: selection.qualifiedId,
            disabled: !enabled,
            busy: actionPending,
            ...(enabled
                ? {
                    onPress: () => onAction({
                        identity: selection.identity,
                        ...(node.input === undefined ? {} : { input: node.input }),
                    }),
                }
                : {}),
        };
    }, [actionPending, isActionAvailable, onAction, showUnavailableActions]);

    const renderField = React.useCallback((): React.ReactNode => null, []);
    // A persisted transcript has no captured Account Data client or query
    // descriptor projection. It must not manufacture either one to render a
    // live collection node.
    const renderCollectionList = React.useCallback((): React.ReactNode => null, []);

    return (
        <View testID="plugin-structured-message-declarative">
            {renderDeclarativeNode(props.root, {
                colors: theme.colors,
                presentationTheme,
                minimumTouchTarget,
                // A persisted transcript replays the author's frozen words. It
                // is deliberately independent of whatever plugin translation
                // bundle is installed now — the message is history, not live UI.
                localize: readDeclarativeText,
                resolveAction,
                renderField,
                renderCollectionList,
            })}
        </View>
    );
}
