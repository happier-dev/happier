import * as React from 'react';
import type { PluginUiReviewContextV1 } from '@happier-dev/protocol/plugins/ui';
import { useAppShellPluginUiPageProjection, useAppShellPluginUiProjectionCurrentness, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { DetailsPaneSlotHost } from '@/components/appShell/panes/details/DetailsPaneSlot';
import { PluginPageContent } from '@/components/plugins/pages/PluginPageContent';
import { resolvePluginPageForRoute, selectPluginPagePlacements, usePluginPages, type PluginPage } from '@/components/plugins/pages/pluginPages';
import { buildPluginPageRoutePath, type PluginPageTarget, type PluginReviewPageSelection } from '@/components/plugins/pages/pluginPageRoute';
import { PluginPageLaunchInputScope, usePluginPageCatalogActivationHandler, usePluginPageDestinationHandler } from '@/components/plugins/pages/pluginPageNavigation';
import { PluginSurfaceDestinationNavigationBindingProvider, usePluginSurfaceDestinationNavigationBinding, usePluginSurfaceDestinationNavigationBindingForScope, useRegisterPluginSurfaceDestinationNavigationOwner } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { t } from '@/text';
import { PluginInlineSurfaceHost } from '@/components/plugins/surfaces/PluginSurfaceHost';
import { selectRenderablePluginInlineSurfacePlacementsForRole } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

type FindingContext = Extract<PluginUiReviewContextV1, { kind: 'finding' }>;
type OptionsContext = Extract<PluginUiReviewContextV1, { kind: 'engineOptions' }>;

/** Called only inside the opened, readable finding; its core text and decisions remain the fallback. */
export function ReviewFindingPluginContent(props: Readonly<{
  reviewId: string; commentId: string; extensions: Readonly<Record<string, FindingContext['extension']>>; serverId: string;
}>) {
  const runtime = useAppShellPluginUiProjectionCurrentness();
  const contexts = React.useMemo(() => Object.entries(props.extensions).map(([namespace, extension]): FindingContext =>
    ({ kind: 'finding', reviewId: props.reviewId, commentId: props.commentId, namespace, extension })),
  [props.extensions, props.reviewId, props.commentId]);
  return <>{contexts.map(review => <ReviewPluginSurfaceBinding
    key={review.namespace} runtime={runtime} serverId={props.serverId} review={review} />)}</>;
}

export function ReviewEngineOptionsPluginContent(props: Readonly<{
  pluginId: string; engineId: string; profileId: string; options: OptionsContext['options']; serverId: string;
}>) {
  const runtime = useAppShellPluginUiProjectionCurrentness();
  const review = React.useMemo((): OptionsContext => ({ kind: 'engineOptions', engineId: props.engineId,
    profileId: props.profileId, options: props.options }), [props.engineId, props.profileId, props.options]);
  return <ReviewPluginSurfaceBinding runtime={runtime} serverId={props.serverId} pluginId={props.pluginId}
    review={review} />;
}

type ReviewPageProps = Readonly<{
  reviewId: string; serverId: string | null; selection?: PluginReviewPageSelection | null;
  children: (menu: readonly PageHeaderMenuAction[]) => React.ReactNode;
}>;

/** The opened Artifact lends its identity; the ordinary page owner retains navigation and companions. */
export function ReviewPagePluginContent(props: ReviewPageProps) {
  const projection = useAppShellPluginUiPageProjection();
  const localize = useProjectedPluginLocalizedTextResolver();
  const serverId = projection.accountLifetime?.scope.serverId;
  const target = React.useMemo(() => ({ kind: 'app' as const,
    context: { kind: 'review' as const, reviewId: props.reviewId } }), [props.reviewId]);
  const placements = React.useMemo(() => serverId && props.serverId
    && areServerProfileIdentifiersEquivalent(serverId, props.serverId)
    ? selectPluginPagePlacements(projection.pluginUiProjection, { container: 'appPage', targetKind: 'app' }, 'review')
    : [], [projection.pluginUiProjection, serverId, props.serverId]);
  const pages = usePluginPages({ target, placements, localize });
  return <PluginPageLaunchInputScope pluginUiProjection={projection.pluginUiProjection} target={target} pages={pages}>
    <ReviewPageNavigation {...props} target={target} pages={pages} projection={projection} />
  </PluginPageLaunchInputScope>;
}

function ReviewPageNavigation(props: ReviewPageProps & Readonly<{
  target: PluginPageTarget; pages: readonly PluginPage[]; projection: ReturnType<typeof useAppShellPluginUiPageProjection>;
}>) {
  const enclosing = usePluginSurfaceDestinationNavigationBinding();
  const placements = React.useMemo(() => props.pages.map(page => page.placement), [props.pages]);
  const binding = usePluginSurfaceDestinationNavigationBindingForScope({ placements,
    projection: props.projection.pluginUiProjection, targetKind: 'app',
    accountLifetime: props.projection.accountLifetime, enclosingOpenSurface: enclosing?.openSurface });
  const handler = usePluginPageDestinationHandler({ pages: props.pages });
  const owner = React.useMemo(() => ({ container: 'appPage' as const, handler }), [handler]);
  useRegisterPluginSurfaceDestinationNavigationOwner(owner, binding);
  const activate = usePluginPageCatalogActivationHandler();
  const menu = React.useMemo(() => props.pages.map((page): PageHeaderMenuAction => ({ id: page.id,
    title: page.label, disabled: Boolean(page.disabledReason), onSelect: () => activate(page) })), [props.pages, activate]);
  const selection = props.selection;
  const page = selection ? resolvePluginPageForRoute({ pages: props.pages, ...selection }) : null;
  const review = React.useMemo(() => ({ kind: 'page' as const, reviewId: props.reviewId }), [props.reviewId]);
  const routePathFor = React.useCallback((subPath: string, view: string | null) => buildPluginPageRoutePath({
    ...props.target, pluginId: selection?.pluginId ?? '', localId: selection?.localId ?? '', subPath, view,
  }), [props.target, selection?.pluginId, selection?.localId]);
  const title = page?.label ?? t('pluginSurfaces.appPage.title');
  const renderContent = React.useCallback((content: React.ReactElement) => <DetailsPaneSlotHost
    testID="review-plugin-page-details" mainColumn={{ hideLabel: t('panes.mainColumn.hidePage', { title }),
      showLabel: t('panes.mainColumn.showPage', { title }), identity: { name: title } }}>{content}</DetailsPaneSlotHost>, [title]);
  return <PluginSurfaceDestinationNavigationBindingProvider binding={binding}>
    {selection ? <PluginPageContent {...selection} page={page} views={props.pages} projection={props.projection}
      initialView={selection.view} routePathFor={routePathFor} reviewContext={review} renderContent={renderContent} appChrome />
      : props.children(menu)}
  </PluginSurfaceDestinationNavigationBindingProvider>;
}

/** Physical insertion consumes the same admitted projection/currentness as other contextual plugin slots. */
function ReviewPluginSurfaceBinding(props: Readonly<{
  runtime: PluginUiProjectionCurrentness; review: FindingContext | OptionsContext; serverId: string; pluginId?: string;
}>) {
  const { runtime, review } = props;
  const isHostCurrent = React.useCallback(() => runtime.interactionEnabled
    && runtime.accountLifetime?.isCurrent() === true, [runtime.accountLifetime, runtime.interactionEnabled]);
  const serverId = runtime.accountLifetime?.scope.serverId;
  if (!runtime.pluginUiProjection || !serverId
    || !areServerProfileIdentifiersEquivalent(serverId, props.serverId)) return null;
  const host = { serverId, machineId: runtime.machineId, platform: runtime.platform,
    pluginUiProjection: runtime.pluginUiProjection, projectionInteractionEnabled: runtime.interactionEnabled,
    isHostCurrent, reviewContext: review };
  const role = review.kind === 'finding' ? 'reviewFinding' : 'reviewEngineOptions';
  const pluginId = review.kind === 'finding' ? review.namespace : props.pluginId;
  return <>{selectRenderablePluginInlineSurfacePlacementsForRole(runtime.pluginUiProjection, role)
    .filter(placement => placement.binding.surface.pluginId === pluginId).map(placement =>
      <PluginInlineSurfaceHost key={placement.id} placement={placement} inlineMount={{ role, presentation: 'content' }} {...host} />)}</>;
}
