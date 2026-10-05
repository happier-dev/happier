import * as React from 'react';

import { Tabs, usePluginTranslation, type TabsItemProps } from '@happier-dev/plugin-ui';
import type { TriageDetailSurfaceInputV1, TriageSourceEntryLocalRefV1 } from '@happier-dev/triage-protocol/v1';

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
    input.instance.instance.sourceInstanceId, input.instance.binding.purpose,
    input.instance.binding.account.service.pluginId, input.instance.binding.account.service.localId,
    input.instance.binding.account.accountId, input.instance.localInstanceKey, input.instance.configuration.token,
    entryRef.source.pluginId, entryRef.source.localId, entryRef.kindId, entryRef.collisionScope, entryRef.entryId,
  ]);
}

/** One root interval across source panels, nested under the host's source slot. */
export function TriageDetailInstance({ children }: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  const text = usePluginTranslation();
  const label = text('plugins.triage.detailStory.detail', 'Source detail');
  return <Tabs value="detail" onValueChange={noop} ariaLabel={label} tabList="host">
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
  /** The source's own name for its detail, announced for the panel region. */
  ariaLabel: string;
  /** Content per panel id; absent or `null` ids are not offered by this kind. */
  panels: Readonly<Record<string, React.ReactNode>>;
  /** Source-owned panel retention; hidden panels still end their activity. */
  retention?: Readonly<Record<string, TabsItemProps['retention']>>;
}>): React.ReactElement {
  const panels = Object.hasOwn(props.panels, props.panel)
    ? props.panels
    : { ...props.panels, [props.panel]: null };
  return (
    <Tabs value={props.panel} onValueChange={noop} ariaLabel={props.ariaLabel} tabList="host">
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
