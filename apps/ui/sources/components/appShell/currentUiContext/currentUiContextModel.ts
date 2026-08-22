import type { ModalType } from '@/modal';
import type { TabType } from '@/components/ui/navigation/tabTypes';
import type { ResolvedSettingsPageNode, SettingsPageId } from '@/components/settings/catalog/types';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
import type { ParameterFreeRouteProjection } from '@/track/parameterFreeRouteProjection';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { redactVoicePathLikeString } from '@/voice/shared/redactVoicePathLikeData';
import {
    CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1,
    CurrentUiContextSnapshotV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import type {
    CurrentUiCommandDescriptorV1,
    CurrentUiContextSnapshotV1,
    PluginUiResolvedSemanticCommandV1,
} from '@happier-dev/protocol/plugins/ui';

export type CurrentUiNavigation = CurrentUiContextSnapshotV1['navigation'];

type CurrentUiContextSessionTitleSource = Parameters<typeof getSessionName>[0];
type CurrentUiContextMachineLabelSource = Parameters<typeof getMachineDisplayName>[0];

type CurrentUiContextFrameworkPrivacy = Readonly<{
    shareSessionSummary: boolean;
    shareFilePaths: boolean;
    shareDeviceInventory: boolean;
}>;

/**
 * Host-normalized semantic data held only by the exact mounted surface. The
 * composer receives the projection below, never these executable command
 * payloads.
 */
export type CurrentUiContextMountedEnrichment = Readonly<{
    entity?: CurrentUiContextSnapshotV1['entity'];
    detail?: CurrentUiContextSnapshotV1['detail'];
    commands?: readonly Readonly<{
        title: string;
        description?: string;
        command: PluginUiResolvedSemanticCommandV1;
    }>[];
}>;

/** The safe, descriptor-only projection admitted into the current snapshot. */
export type CurrentUiContextMountProjection = Readonly<{
    entity?: CurrentUiContextSnapshotV1['entity'];
    detail?: CurrentUiContextSnapshotV1['detail'];
    commands: readonly CurrentUiCommandDescriptorV1[];
}>;

export type CurrentUiContextCompositionInput = Readonly<{
    route: ParameterFreeRouteProjection;
    visibleModalKind?: ModalType | null;
    /** Only the incumbent active details workspace may set this fact. */
    focusedDetailsWorkspace?: boolean;
    /** Resolved by the Settings catalog; no page identity reaches this model. */
    settings?: Readonly<{
        title: string;
        /** Marks only the host-recognized generic external plugin Settings leaf. */
        pluginSettingsPage?: boolean;
    }> | null;
    /** Resolved by the admitted plugin-page catalog; no route identity reaches this model. */
    pluginPage?: Readonly<{ label: string }> | null;
    /** The Session visibility owner confirms this route is the active client surface. */
    sessionActive?: boolean;
    /** The Session header title source for this exact focused Session route. */
    session?: CurrentUiContextSessionTitleSource | null;
    /** The machine selector confirms this route still resolves to an active machine. */
    machineActive?: boolean;
    /** The incumbent machine display projection source for this exact route. */
    machine?: CurrentUiContextMachineLabelSource | null;
    /** Provider-bound Voice disclosure facts; malformed/missing values arrive fail-closed. */
    privacy?: CurrentUiContextFrameworkPrivacy;
    mobileTab?: TabType | null;
    /**
     * The one exact mounted controller may contribute a descriptor-only
     * projection. Modal and workspace owners still take precedence.
     */
    mountEnrichment?: CurrentUiContextMountProjection | null;
}>;

type ActiveDetailsWorkspaceSource = Readonly<{
    activeScopeId: string | null;
    scopes: Readonly<Record<string, Readonly<{
        details: Readonly<{
            isOpen: boolean;
            focusedGroupId: string | null;
        }>;
    }>>>;
}>;

/**
 * `activeScopeId` is the incumbent AppPane owner for current pane context.
 * Do not infer a global focus from another open scope or a pane tab.
 */
export function hasActiveDetailsWorkspace(source: ActiveDetailsWorkspaceSource): boolean {
    const activeScopeId = source.activeScopeId;
    const details = activeScopeId === null ? null : source.scopes[activeScopeId]?.details ?? null;
    return details?.isOpen === true && details.focusedGroupId !== null;
}

/**
 * The focused Session selector is an opaque identity source. Keep that
 * identity inside the composer and require it to describe this route before
 * surfacing the Session framework area.
 */
export function hasCurrentSessionRoute(
    focusedSessionId: string | null,
    routeSessionId: string,
): boolean {
    return focusedSessionId !== null && routeSessionId.length > 0 && focusedSessionId === routeSessionId;
}

/** The Settings catalog resolves route matching; this reads its one active resolved node. */
export function readCurrentUiContextSettingsPage(input: Readonly<{
    tree: readonly ResolvedSettingsPageNode[];
    activePageId: SettingsPageId | null;
}>): ResolvedSettingsPageNode | null {
    if (input.activePageId === null) return null;
    for (const node of input.tree) {
        if (node.id === input.activePageId) return node;
        if (node.children) {
            const child = readCurrentUiContextSettingsPage({
                tree: node.children,
                activePageId: input.activePageId,
            });
            if (child !== null) return child;
        }
    }
    return null;
}

/**
 * The mounted surface validates its own enrichment, but the navigation and
 * descriptor projection added here can still make the final provider-facing
 * snapshot exceed the one transport bound. Qualify at this sole composition
 * boundary and withhold the optional surface data rather than silently
 * truncating a command descriptor.
 */
function qualifyCurrentUiContextSnapshot(
    snapshot: CurrentUiContextSnapshotV1,
): CurrentUiContextSnapshotV1 {
    if (CurrentUiContextSnapshotV1Schema.safeParse(snapshot).success) {
        return snapshot;
    }

    const boundedSnapshot: CurrentUiContextSnapshotV1 = Object.freeze({
        navigation: Object.freeze({
            area: snapshot.navigation.area,
            screen: snapshot.navigation.screen,
            ...(snapshot.navigation.presentation === undefined
                ? {}
                : { presentation: snapshot.navigation.presentation }),
        }),
        detail: CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1,
        commands: [],
    });
    if (CurrentUiContextSnapshotV1Schema.safeParse(boundedSnapshot).success) {
        return boundedSnapshot;
    }

    return Object.freeze(CurrentUiContextSnapshotV1Schema.parse({
        navigation: {
            area: 'app',
            screen: 'context.incomplete',
            presentation: 'screen',
        },
        detail: CURRENT_UI_CONTEXT_BOUNDED_INCOMPLETENESS_V1,
        commands: [],
    }));
}

export function composeCurrentUiContextSnapshotFromNavigation(
    navigation: CurrentUiNavigation,
    mountEnrichment?: CurrentUiContextMountProjection | null,
): CurrentUiContextSnapshotV1 {
    // Rebuild descriptors at the consumer boundary so a malformed or future
    // host-private record cannot smuggle semantic command payloads into the
    // provider-facing snapshot.
    const commands: CurrentUiCommandDescriptorV1[] = mountEnrichment
        ? mountEnrichment.commands.map((command) => ({
            id: command.id,
            title: command.title,
            ...(command.description === undefined ? {} : { description: command.description }),
        }))
        : [];
    return qualifyCurrentUiContextSnapshot(Object.freeze({
        navigation: Object.freeze(navigation),
        ...(mountEnrichment?.entity === undefined ? {} : { entity: mountEnrichment.entity }),
        ...(mountEnrichment?.detail === undefined ? {} : { detail: mountEnrichment.detail }),
        commands,
    }));
}

function createRouteBaseline(route: ParameterFreeRouteProjection): CurrentUiContextSnapshotV1 {
    return composeCurrentUiContextSnapshotFromNavigation({
        // Route structure is a privacy-safe navigation pattern, not proof of a
        // current Session or machine domain owner. Those areas are enriched
        // below only by their incumbent current selectors.
        area: 'app',
        screen: route.route || 'home',
        presentation: 'screen',
    });
}

/**
 * Session header titles can fall back to a workspace path tail. The context
 * composer may use the incumbent header projection, but it must not turn that
 * fallback into provider metadata unless file-path sharing is enabled too.
 */
function hasNonPathSessionHeaderTitle(session: CurrentUiContextSessionTitleSource): boolean {
    if (readSessionDisplayTitleField(session).value !== null) return true;
    const ownerName = readSessionOwnerMetadataView(session)?.name;
    return typeof ownerName === 'string' && ownerName.trim().length > 0;
}

function readPrivacyQualifiedSessionTitle(input: CurrentUiContextCompositionInput): string | null {
    const session = input.session;
    const privacy = input.privacy;
    if (!session || privacy?.shareSessionSummary !== true) return null;
    if (privacy.shareFilePaths !== true && !hasNonPathSessionHeaderTitle(session)) return null;

    const title = getSessionName(session);
    return privacy.shareFilePaths === true ? title : redactVoicePathLikeString(title);
}

function readPrivacyQualifiedMachineLabel(input: CurrentUiContextCompositionInput): string | null {
    if (input.privacy?.shareDeviceInventory !== true) return null;
    return getMachineDisplayName(input.machine);
}

/**
 * Composes the one current UI snapshot in priority order. The provider admits
 * mount data only after its exact controller committed; this model sees only
 * the resulting opaque descriptor projection.
 */
export function composeCurrentUiContextSnapshot(
    input: CurrentUiContextCompositionInput,
): CurrentUiContextSnapshotV1 {
    if (input.visibleModalKind) {
        return composeCurrentUiContextSnapshotFromNavigation({
            area: 'modal',
            screen: input.visibleModalKind,
            presentation: 'modal',
        });
    }

    if (input.focusedDetailsWorkspace === true) {
        return composeCurrentUiContextSnapshotFromNavigation({
            area: 'workspace',
            screen: 'details',
            presentation: 'pane',
        });
    }

    const baseline = createRouteBaseline(input.route);
    if (input.route.segments[0] === 'settings' && input.settings?.title) {
        return composeCurrentUiContextSnapshotFromNavigation({
            ...baseline.navigation,
            area: 'settings',
            ...(input.settings.pluginSettingsPage === true ? { screen: 'settings.plugin_page' } : {}),
            title: input.settings.title,
        }, input.mountEnrichment);
    }

    if (input.route.segments[0] === 'plugins') {
        return composeCurrentUiContextSnapshotFromNavigation({
            area: 'plugin',
            screen: 'page',
            presentation: 'screen',
            ...(input.pluginPage?.label ? { title: input.pluginPage.label } : {}),
        }, input.mountEnrichment);
    }

    if (input.sessionActive === true && input.route.segments[0] === 'session') {
        const title = readPrivacyQualifiedSessionTitle(input);
        return composeCurrentUiContextSnapshotFromNavigation({
            ...baseline.navigation,
            area: 'session',
            ...(title === null ? {} : { title }),
        }, input.mountEnrichment);
    }

    if (input.machineActive === true && input.route.segments[0] === 'machine') {
        const title = readPrivacyQualifiedMachineLabel(input);
        return composeCurrentUiContextSnapshotFromNavigation({
            ...baseline.navigation,
            area: 'machine',
            ...(title === null ? {} : { title }),
        }, input.mountEnrichment);
    }

    if (input.route.segments.length === 0 && input.mobileTab) {
        return composeCurrentUiContextSnapshotFromNavigation({
            area: 'app',
            screen: `tab.${input.mobileTab}`,
            presentation: 'screen',
        }, input.mountEnrichment);
    }

    return composeCurrentUiContextSnapshotFromNavigation(baseline.navigation, input.mountEnrichment);
}
