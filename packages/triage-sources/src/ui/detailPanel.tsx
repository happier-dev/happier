import * as React from 'react';

import { Tabs, usePluginTranslation, type TabsItemProps } from '@happier-dev/plugin-ui';
import type { TriageDetailSurfaceInputV1, TriageSourceEntryLocalRefV1 } from '@happier-dev/triage-protocol/v1';
import { triageSourceBindingComponentsV1 } from '@happier-dev/triage-protocol/v1';
import { useTriageDetailPanelVisibility } from './detailPanelNavigation.js';
import { resolveTriageCrossCopyContext } from './crossCopyContext.js';

/** Exact read authority, independent of freshly parsed navigation inputs. */
export function useTriageDetailRequest(input: TriageDetailSurfaceInputV1): Readonly<{
  instance: TriageDetailSurfaceInputV1['instance'];
  localRef: TriageSourceEntryLocalRefV1;
}> {
  const { entryRef } = input.observation;
  return React.useMemo(() => ({
    instance: input.instance,
    localRef: { kindId: entryRef.kindId, collisionScope: entryRef.collisionScope, entryId: entryRef.entryId },
  }), [
    input.instance.instance.source.pluginId, input.instance.instance.source.localId,
    input.instance.instance.sourceInstanceId, JSON.stringify(triageSourceBindingComponentsV1(input.instance.binding)),
    input.instance.localInstanceKey, input.instance.configuration.token,
    entryRef.source.pluginId, entryRef.source.localId, entryRef.kindId, entryRef.collisionScope, entryRef.entryId,
  ]);
}

/**
 * A source-declared List owns its one vertical scroller (QB-55/81). The frame and source wrappers consume
 * the same declaration so the List fills its bounded region instead of growing inside a competing scroller.
 */
export function triageDetailPanelOwnsScrollerV1(scrollOwner: TriageDetailSurfaceInputV1['panelScrollOwner']): boolean {
  return scrollOwner === 'list';
}

/**
 * The Triage detail's page-scroll fact (D21, UI refinements 2026-11-08): on a phone the whole detail scrolls as one
 * page (lab `merged-detail-*-phone`), so a source panel's List joins that page instead of keeping a bounded scroller.
 * The frame decides it once, from the placement that already presents the detail as a pushed page.
 */
const TRIAGE_DETAIL_PAGE_SCROLL_CONTEXT_KEY = Symbol.for('happier.triageSources.privateDetailPageScrollContext.v1');
const TriageDetailPageScrollContext = resolveTriageCrossCopyContext<boolean>(TRIAGE_DETAIL_PAGE_SCROLL_CONTEXT_KEY, false);

export function TriageDetailPageScrollProvider(props: Readonly<{ pageScroll: boolean; children: React.ReactNode }>): React.ReactElement {
  return <TriageDetailPageScrollContext.Provider value={props.pageScroll}>{props.children}</TriageDetailPageScrollContext.Provider>;
}

/** The panel Tabs layout: the page's own flow on a phone, else the bounded region a source List owns. */
function useTriageDetailPanelLayout(scrollOwner: TriageDetailSurfaceInputV1['panelScrollOwner']): TabsItemLayout {
  const pageScroll = React.useContext(TriageDetailPageScrollContext);
  if (pageScroll) return { layout: 'page' };
  return triageDetailPanelOwnsScrollerV1(scrollOwner) ? { layout: 'fill' } : {};
}

type TabsItemLayout = Readonly<{ layout?: 'fill' | 'page' }>;

/** One root interval across source panels, nested under the host's source slot. */
export function TriageDetailInstance({ children, scrollOwner }: Readonly<{
  children: React.ReactNode;
  /** The selected source tab's declaration (`input.panelScrollOwner`). */
  scrollOwner?: TriageDetailSurfaceInputV1['panelScrollOwner'];
}>): React.ReactElement {
  const text = usePluginTranslation();
  const label = text('plugins.triage.detailStory.detail', 'Source detail');
  const layout = useTriageDetailPanelLayout(scrollOwner);
  return <Tabs value="detail" onValueChange={noop} ariaLabel={label} tabList="host" {...layout}>
    <Tabs.Item value="detail" title={label}>{children}</Tabs.Item>
  </Tabs>;
}

/**
 * A source detail body rendering the one panel the Triage detail asked for
 * (r0.42).
 *
 * The Triage frame owns the tab strip and the shared vocabulary; the source
 * renders its content for `input.panel` only, inside its own panel interval, so
 * its panel readers keep their active/abort lifetime exactly as they had it in
 * the source's own tabs. The target asks only for panels this kind declares,
 * so a panel id with no content renders nothing rather than inventing copy.
 */
export function TriageDetailPanel(props: Readonly<{
  panel: string;
  /** Current source-owned conditional panel result; omitted when every declared panel is offered. */
  visiblePanels?: readonly string[];
  scrollOwner?: TriageDetailSurfaceInputV1['panelScrollOwner'];
  /** The source's own name for its detail, announced for the panel region. */
  ariaLabel: string;
  /** Content per panel id; absent or `null` ids are not offered by this kind. */
  panels: Readonly<Record<string, React.ReactNode>>;
  /** Source-owned panel retention; hidden panels still end their activity. */
  retention?: Readonly<Record<string, TabsItemProps['retention']>>;
}>): React.ReactElement {
  useTriageDetailPanelVisibility(props.visiblePanels);
  const layout = useTriageDetailPanelLayout(props.scrollOwner);
  const panels = Object.hasOwn(props.panels, props.panel)
    ? props.panels
    : { ...props.panels, [props.panel]: null };
  return (
    <Tabs value={props.panel} onValueChange={noop} ariaLabel={props.ariaLabel} tabList="host" {...layout}>
      {Object.entries(panels).map(([id, content]) => (
        <Tabs.Item key={id} value={id} title={id}
          {...(props.retention?.[id] === undefined ? {} : { retention: props.retention[id] })}
        >
          {content}
        </Tabs.Item>
      ))}
    </Tabs>
  );
}

function noop(): void {}
