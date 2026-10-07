import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';

import { ACTION_IDS } from '@happier-dev/protocol/actions/actionIds';
import type { PluginDeclarativeDocumentNormalizationV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeDocument';
import { normalizeSessionSurfaceDeclarativeDocumentV1 } from '@happier-dev/protocol/sessions/board';

import {
    readDeclarativeText,
    renderDeclarativeNode,
} from '@/components/plugins/shared/declarativeNodes';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { WidgetSnapshotNote } from '@/components/widgets/definitions/WidgetSnapshotNote';

import {
    createSessionBoardHostActionResolver,
    type SessionBoardHostActionBinding,
} from './sessionBoardHostActions';

/** Mount-time admission is fail-closed; malformed/stale content renders no executable leaf. */
export function resolveSessionBoardDeclarativeContentDocument(
    document: unknown,
): PluginDeclarativeDocumentNormalizationV1 | null {
    try {
        return normalizeSessionSurfaceDeclarativeDocumentV1({
            document,
            admittedHostActions: ACTION_IDS,
        });
    } catch {
        return null;
    }
}

/**
 * A Session Board item's declarative document, rendered by the ONE host
 * declarative renderer.
 *
 * There is no Board node vocabulary, Board renderer, or Board component set: the
 * document is the same grammar a plugin surface and a transcript block use, and this
 * module supplies only what a Session record owns differently.
 *
 * - Text is the author's frozen words (`readDeclarativeText`). A stored Session
 *   document is content, not live plugin UI, so it is deliberately independent of
 *   whichever plugin translation bundle happens to be installed.
 * - Settings fields, Account Collection lists and targeted surfaces resolve to
 *   nothing: a Session record has no plugin identity, generation, Data client or
 *   target-local bridge, and must never manufacture one.
 * - Actions resolve only through the canonical host-Action seam.
 */
export function SessionBoardDeclarativeContent(props: Readonly<{
    /** The stored `source.kind === 'declarative'` document. */
    document: unknown;
    actionBinding?: SessionBoardHostActionBinding | null;
    /** A posted snapshot: frozen numbers that say they will not update (lab VS). */
    snapshot?: boolean;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const widgetPresentation = useWidgetPresentation();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const minimumTouchTarget = resolveMinimumInteractiveTargetSize(Platform.OS);
    const actionBinding = props.actionBinding ?? null;

    const resolveAction = React.useMemo(
        () => createSessionBoardHostActionResolver(actionBinding),
        [actionBinding],
    );
    const renderNothing = React.useCallback((): React.ReactNode => null, []);

    const normalized = React.useMemo(
        () => resolveSessionBoardDeclarativeContentDocument(props.document),
        [props.document],
    );

    return (
        <View testID={props.testID ?? 'session-board-declarative'}>
            {renderDeclarativeNode(normalized?.root ?? null, {
                colors: theme.colors,
                presentationTheme,
                widgetPresentation,
                minimumTouchTarget,
                localize: readDeclarativeText,
                useSharedSpinner: true,
                markdownProfile: 'widget',
                resolveAction,
                renderField: renderNothing,
                renderCollectionList: renderNothing,
            })}
            {props.snapshot ? <WidgetSnapshotNote /> : null}
        </View>
    );
}
