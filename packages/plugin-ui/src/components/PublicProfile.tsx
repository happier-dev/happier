import { createContext, useContext, useMemo, type ComponentProps, type ReactNode } from 'react';
import {
  HappierPublicProfile as ProfilePresentation,
  HappierPublicProfileWidget as WidgetPresentation,
  type HappierPublicProfileProps as PresentationProps,
  type PublicProfileProjection,
} from '../presentation/account/PublicProfile.js';
import type { PublicProfileInputView } from './publicProfileTypes.js';
import type { HappierPublicProfileUsageHost } from '../presentation/account/PublicProfileUsage.js';
import { renderInertDeclarativeView } from '../declarative/inertDeclarativeView.js';
import { projectPublicUsageChartModels, projectPublicUsageRecords } from '../data/publicUsageChartModels.js';
import { resolveWidgetGroupCells } from '../data/widgetGroupLayout.js';
export { HAPPIER_PUBLIC_PROFILE_HERO_METRICS } from '../presentation/layout/pageMetrics.js';
export type { HappierPublicProfileBrand, HappierPublicProfileHeroGeometry, HappierPublicProfileLabels, HappierPublicProfileOwner } from '../presentation/account/PublicProfile.js';
export type { HappierPublicProfileUsageHost, HappierPublicProfileUsageLabels } from '../presentation/account/PublicProfileUsage.js';

type PublishedProps = Omit<Extract<PresentationProps, { view: unknown }>, 'view' | 'projection'> & Readonly<{ view: PublicProfileInputView }>;
export type HappierPublicProfileProps = PublishedProps | Extract<PresentationProps, { result: unknown }>;

function profileCells(view: PublicProfileInputView) {
  return new Map(resolveWidgetGroupCells('corePage', view.layout.items.flatMap(item =>
    item.kind === 'widget' ? [item] : [{ id: item.id, size: undefined }, ...item.children])).map(cell => [cell.id, cell]));
}

function usePublicProfileProjection(view: PublicProfileInputView, usage: HappierPublicProfileUsageHost | undefined): PublicProfileProjection {
  const models = useMemo(() => view.snapshot ? projectPublicUsageChartModels(view.snapshot, view.metadata) : null,
    [view.snapshot, view.metadata]);
  const format = usage?.labels.records?.format;
  const records = useMemo(() => format && view.snapshot ? projectPublicUsageRecords(view.snapshot, format) : null,
    [view.snapshot, format]);
  return { models, records, cells: profileCells(view), renderDeclarative: renderInertDeclarativeView };
}

type SharedProfileData = Readonly<{
  snapshot: PublicProfileInputView['snapshot']; metadata: PublicProfileInputView['metadata'];
  format: HappierPublicProfileUsageHost['labels']['records']; projection: PublicProfileProjection;
}>;
const PublicProfileDataContext = createContext<SharedProfileData | null>(null);

/** A composed page/setup owns one model projection; children only supply their admitted placement. */
export function HappierPublicProfileDataProvider(props: Readonly<{
  view: PublicProfileInputView; usage?: HappierPublicProfileUsageHost; children: ReactNode;
}>) {
  const projection = usePublicProfileProjection(props.view, props.usage);
  return <PublicProfileDataContext.Provider value={{ snapshot: props.view.snapshot, metadata: props.view.metadata,
    format: props.usage?.labels.records, projection }}>{props.children}</PublicProfileDataContext.Provider>;
}

function useSharedProjection(view: PublicProfileInputView, usage: HappierPublicProfileUsageHost | undefined) {
  const shared = useContext(PublicProfileDataContext);
  return shared && shared.snapshot === view.snapshot && shared.metadata === view.metadata && shared.format === usage?.labels.records
    ? shared.projection : null;
}

function PublishedPublicProfile(props: PublishedProps) {
  const shared = useSharedProjection(props.view, props.usage);
  return shared ? <ProfilePresentation {...props} projection={{ ...shared, cells: profileCells(props.view) }} />
    : <HappierPublicProfileDataProvider view={props.view} usage={props.usage}><PublishedPublicProfile {...props} /></HappierPublicProfileDataProvider>;
}

/** SDK DTO projection stays in the adapter; all page markup has one shared owner. */
export function HappierPublicProfile(props: HappierPublicProfileProps) {
  return 'result' in props ? <ProfilePresentation {...props} /> : <PublishedPublicProfile {...props} />;
}

export function HappierPublicProfileWidget(props: Omit<ComponentProps<typeof WidgetPresentation>, 'view' | 'projection'> & Readonly<{ view: PublicProfileInputView }>) {
  const shared = useSharedProjection(props.view, props.usage);
  return shared ? <WidgetPresentation {...props} projection={shared} />
    : <HappierPublicProfileDataProvider view={props.view} usage={props.usage}><HappierPublicProfileWidget {...props} /></HappierPublicProfileDataProvider>;
}
