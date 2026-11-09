import type { PluginManifest } from '../manifest.js';
import { resolvePluginUiDestinationBindingSlotV1 } from '@happier-dev/protocol/plugins/contributions/ui/surfaceRegistry';
import type { UiRenderer, UiView } from '../ui.js';
import type { PluginUiSettingsPageV1 } from './publicContract.js';
import type { PluginCollectionListExtensionV1 } from './contributions.js';

type DistributiveOmit<T, TKey extends PropertyKey> = T extends unknown
    ? Omit<T, TKey>
    : never;

type PluginManifestContributes = NonNullable<PluginManifest['contributes']>;
type PluginUiContributionInput = NonNullable<PluginManifestContributes['ui']>;
// The broad manifest projection deliberately accepts advanced raw declarations.
// The high-level surface descriptor needs the canonical discriminated author
// grammar while executable entrypoints remain owned by package exports.

export type UiSurfaceRendererDefinition =
    | DistributiveOmit<Exclude<UiRenderer, Readonly<{ kind: 'hostedHtml' }>>, 'id' | 'artifact' | 'source'>
    | DistributiveOmit<Extract<UiRenderer, Readonly<{ kind: 'hostedHtml' }>>, 'id'>;
export type UiSurfaceReactNativeRendererDefinition = DistributiveOmit<
    Extract<UiRenderer, Readonly<{ kind: 'reactNative' }>>,
    'id' | 'artifact'
>;
export type UiSurfaceHostedWebRendererDefinition = DistributiveOmit<
    Extract<UiRenderer, Readonly<{ kind: 'hostedWeb' }>>,
    'id' | 'source'
>;
export type UiSurfaceDeclarativeRendererDefinition = DistributiveOmit<
    Extract<UiRenderer, Readonly<{ kind: 'declarative' }>>,
    'id'
>;
export type UiSurfaceHostedHtmlRendererDefinition = DistributiveOmit<
    Extract<UiRenderer, Readonly<{ kind: 'hostedHtml' }>>,
    'id'
>;
export type UiSurfaceAppPageDefinitionFor<
    TView,
    TRenderer extends UiSurfaceRendererDefinition,
> = TView extends Readonly<{
    id: infer TId;
    container: 'appPage';
    target: infer TTarget;
}>
    ? Readonly<
        DistributiveOmit<TView, 'id' | 'renderer' | 'container' | 'target' | 'placement' | 'fallbackRenderers'> & {
            id: TId;
            placement: 'appPage';
            renderer: TRenderer;
        } & (TTarget extends Readonly<{ kind: 'app' }> ? { target?: TTarget } : { target: TTarget })
    >
    : never;
export type UiSurfaceAppPageDefinition<TRenderer extends UiSurfaceRendererDefinition> =
    UiSurfaceAppPageDefinitionFor<UiView & { container: 'appPage' }, TRenderer>;

export type UiSurfaceDetailedDefinitionFor<
    TView,
    TRenderer extends UiSurfaceRendererDefinition,
> = TView extends Readonly<{
    id: infer TId;
    container: infer TContainer;
    target: infer TTarget;
}>
    ? TContainer extends 'appPage'
        ? never
        : Readonly<
            DistributiveOmit<TView, 'id' | 'renderer' | 'container' | 'target' | 'placement' | 'fallbackRenderers'> & {
                id: TId;
                placement: TContainer;
                target: TTarget;
                renderer: TRenderer;
            }
        >
    : never;
export type UiSurfaceDetailedDefinition<TRenderer extends UiSurfaceRendererDefinition> =
    UiSurfaceDetailedDefinitionFor<UiView, TRenderer>;
export type UiSurfaceSettingsPageDefinition<TRenderer extends UiSurfaceRendererDefinition> = Readonly<
    Omit<PluginUiSettingsPageV1, 'id' | 'renderer'> & {
        id: PluginUiSettingsPageV1['id'];
        placement: 'settingsPage';
        target?: never;
        renderer: TRenderer;
    }
>;
export type UiSurfacePlacement<TRenderer extends UiSurfaceRendererDefinition> =
    | UiSurfaceAppPageDefinition<TRenderer>
    | UiSurfaceDetailedDefinition<TRenderer>
    | UiSurfaceSettingsPageDefinition<TRenderer>;

/**
 * A renderer-only surface has no destination, view, or settings-page
 * placement. It exists for host-owned composition slots such as Composer
 * pickers, attachment display/preview, and Composer regions.
 */
export type UiSurfaceRendererOnlyDefinition<TRenderer extends UiSurfaceRendererDefinition> = Readonly<{
    id: string;
    placement: 'rendererOnly';
    renderer: TRenderer;
}>;

/**
 * The common cold-manifest surface shorthand. It derives the renderer and
 * executable artifact id from the surface id. Raw `ui.views` / `ui.renderers`
 * remain the advanced route for shared renderers, fallback chains, and custom
 * artifact identities.
 */
export type UiSurface =
    | UiSurfacePlacement<UiSurfaceRendererDefinition>
    | UiSurfaceRendererOnlyDefinition<UiSurfaceRendererDefinition>;

/**
 * One high-level surface declaration. Executable entrypoints are discovered
 * from the plugin package's exact exports rather than duplicated here.
 */
export type UiSurfaceReactNativeDefinition = (
    | UiSurfacePlacement<UiSurfaceReactNativeRendererDefinition>
    | UiSurfaceRendererOnlyDefinition<UiSurfaceReactNativeRendererDefinition>
);
export type UiSurfaceHostedWebDefinition = (
    | UiSurfacePlacement<UiSurfaceHostedWebRendererDefinition>
    | UiSurfaceRendererOnlyDefinition<UiSurfaceHostedWebRendererDefinition>
);
export type UiSurfaceDeclarativeDefinition =
    | UiSurfacePlacement<UiSurfaceDeclarativeRendererDefinition>
    | UiSurfaceRendererOnlyDefinition<UiSurfaceDeclarativeRendererDefinition>;

export type UiSurfaceDefinition =
    | UiSurfaceReactNativeDefinition
    | UiSurfaceHostedWebDefinition
    | UiSurfaceDeclarativeDefinition
    | UiSurfacePlacement<UiSurfaceHostedHtmlRendererDefinition>
    | UiSurfaceRendererOnlyDefinition<UiSurfaceHostedHtmlRendererDefinition>;

/** The `definePlugin({ ui })` input, including the high-level surface shorthand. */
export type UiAuthoringInput = Omit<NonNullable<NonNullable<PluginManifest['contributes']>['ui']>, 'listExtensions'> & Readonly<{
    listExtensions?: readonly PluginCollectionListExtensionV1[] | Readonly<Record<string, Omit<PluginCollectionListExtensionV1, 'id'>>>;
    surfaces?: readonly UiSurface[];
}>;

/**
 * Declares one correlated surface definition exactly once. The returned value
 * is consumed by `definePlugin({ ui: { surfaces: [...] } })` for cold manifest
 * projection. `defineUiSurface` remains the separate React artifact entrypoint.
 */
export function defineUiSurfaceDefinition<const TSurface extends UiSurfaceDefinition>(
    surface: TSurface,
): TSurface {
    return surface;
}

/** The one canonical renderer/artifact identity derived by high-level surfaces. */
export function uiSurfaceRendererId(surfaceId: string): string {
    return `${surfaceId}-renderer`;
}

function isUiSurfaceRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readUiSurfaceDeclarations(
    value: unknown,
    field: 'views' | 'renderers' | 'settingsPages',
): readonly unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw new TypeError(`ui.${field} must be an array when ui.surfaces is used`);
    }
    return value;
}

function projectUiSurfaceRenderer(
    surfaceId: string,
    value: unknown,
): Readonly<Record<string, unknown>> {
    if (!isUiSurfaceRecord(value)) {
        throw new TypeError(`ui.surfaces ${surfaceId} requires a renderer object`);
    }
    if (Object.hasOwn(value, 'id')) {
        throw new TypeError(`ui.surfaces ${surfaceId} derives its renderer id; use ui.renderers for a shared renderer`);
    }
    const rendererId = uiSurfaceRendererId(surfaceId);

    switch (value.kind) {
        case 'reactNative':
            if (Object.hasOwn(value, 'artifact')) {
                throw new TypeError(`ui.surfaces ${surfaceId} derives its artifact; use ui.renderers for a custom artifact`);
            }
            return Object.freeze({ ...value, id: rendererId, artifact: rendererId });
        case 'hostedWeb':
            if (Object.hasOwn(value, 'source')) {
                throw new TypeError(`ui.surfaces ${surfaceId} derives its artifact source; use ui.renderers for a custom artifact`);
            }
            return Object.freeze({
                ...value,
                id: rendererId,
                source: Object.freeze({ kind: 'artifact', artifact: rendererId }),
            });
        default:
            // The Protocol parser owns renderer grammar and diagnostics. This
            // author projection owns only the correlated shorthand fields.
            return Object.freeze({ ...value, id: rendererId });
    }
}

/**
 * The canonical high-level-to-cold-manifest projection used by `definePlugin`.
 * It intentionally leaves raw UI declarations untouched when no high-level
 * surface is present.
 */
export function projectUiSurfaceDefinitions(
    value: UiAuthoringInput,
): PluginUiContributionInput {
    const listExtensions = value.listExtensions;
    const ui = (isUiSurfaceRecord(listExtensions)
        ? { ...value, listExtensions: Object.entries(listExtensions).map(([id, definition]) => ({ ...definition, id })) }
        : value) as Readonly<Record<string, unknown>>;
    const surfaces = ui.surfaces;
    if (surfaces === undefined) return ui as PluginUiContributionInput;
    if (!Array.isArray(surfaces)) {
        throw new TypeError('ui.surfaces must be an array');
    }

    const {
        surfaces: _surfaces,
        views: authoredViews,
        renderers: authoredRenderers,
        settingsPages: authoredSettingsPages,
        ...rest
    } = ui;
    const views = [...readUiSurfaceDeclarations(authoredViews, 'views')];
    const renderers = [...readUiSurfaceDeclarations(authoredRenderers, 'renderers')];
    const settingsPages = [...readUiSurfaceDeclarations(authoredSettingsPages, 'settingsPages')];

    for (const surface of surfaces) {
        if (!isUiSurfaceRecord(surface)) {
            throw new TypeError('ui.surfaces entries must be objects');
        }
        if (typeof surface.id !== 'string') {
            throw new TypeError('ui.surfaces entries require a string id');
        }
        if (typeof surface.placement !== 'string') {
            throw new TypeError(`ui.surfaces ${surface.id} requires a placement`);
        }
        if (Object.hasOwn(surface, 'fallbackRenderers')) {
            throw new TypeError(`ui.surfaces ${surface.id} cannot declare fallback renderers; use ui.views`);
        }

        const renderer = projectUiSurfaceRenderer(surface.id, surface.renderer);
        const rendererId = uiSurfaceRendererId(surface.id);
        renderers.push(renderer);

        if (surface.placement === 'rendererOnly') continue;

        if (surface.placement === 'settingsPage') {
            if (Object.hasOwn(surface, 'target')) {
                throw new TypeError(`ui.surfaces ${surface.id} settingsPage implies the app target`);
            }
            const {
                id: _id,
                placement: _placement,
                renderer: _renderer,
                build: _build,
                ...settingsPage
            } = surface;
            settingsPages.push(Object.freeze({
                ...settingsPage,
                id: surface.id,
                renderer: rendererId,
            }));
            continue;
        }

        if (surface.placement === 'appPage') {
            const target = surface.target === undefined ? { kind: 'app' as const } : surface.target;
            if (!isUiSurfaceRecord(target) || resolvePluginUiDestinationBindingSlotV1('appPage', target.kind) === null) {
                throw new TypeError(`ui.surfaces ${surface.id} appPage requires an admitted page target`);
            }
            const {
                id: _id,
                placement: _placement,
                renderer: _renderer,
                build: _build,
                target: _target,
                ...view
            } = surface;
            views.push(Object.freeze({
                ...view,
                id: surface.id,
                container: 'appPage',
                target: Object.freeze({ ...target }),
                renderer: rendererId,
            }));
            continue;
        }

        if (!Object.hasOwn(surface, 'target')) {
            throw new TypeError(`ui.surfaces ${surface.id} requires an explicit target`);
        }
        const {
            id: _id,
            placement: _placement,
            renderer: _renderer,
            build: _build,
            ...view
        } = surface;
        views.push(Object.freeze({
            ...view,
            id: surface.id,
            container: surface.placement,
            renderer: rendererId,
        }));
    }

    return Object.freeze({
        ...rest,
        views: Object.freeze(views),
        renderers: Object.freeze(renderers),
        settingsPages: Object.freeze(settingsPages),
    }) as PluginUiContributionInput;
}
