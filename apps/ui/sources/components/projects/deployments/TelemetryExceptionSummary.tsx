import { DATABASE_CAPTURE_RESOURCE_REF_V1 } from '@happier-dev/database-protocol';
import { PluginServiceListFieldResourceResultV1Schema } from '@happier-dev/plugin-sdk/ui';
import {
  TELEMETRY_LAST_ISSUE_SEEN_FACT_ID,
  TELEMETRY_LATEST_ISSUE_ENTRY_FACT_ID,
  TELEMETRY_OPEN_ISSUES_FIELD,
} from '@happier-dev/plugins-telemetry/capture-views';
import { buildTriageEntryPageV1, readTriageEntryRouteSegmentV1 } from '@happier-dev/triage-protocol/v1';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';

import { useAppShellPluginUiDeclarationSources } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildPluginAppPageRoutePath } from '@/components/plugins/pages/pluginPageRoute';
import { resolvePluginContextualResourceBinding } from '@/components/plugins/surfaces/pluginResourceBinding';
import { PluginContextualResourceState } from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import { Item } from '@/components/ui/lists/Item';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { readPluginUiResourceProjection } from '@/sync/domains/plugins/ui/projection';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

const RESOURCE = {
  pluginId: DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId,
  localId: TELEMETRY_OPEN_ISSUES_FIELD.source.resource,
};

function readExceptionFacts(snapshot: PluginUiResourceSnapshot | null) {
  if (snapshot?.value?.contentType !== 'application/json') return null;
  try {
    const parsed = PluginServiceListFieldResourceResultV1Schema.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot.value.bytes)),
    );
    return parsed.success ? parsed.data.items[0]?.facts ?? null : null;
  } catch {
    return null;
  }
}

/** The latest issue facts follow the selected Account and remain readable when the collector is offline. */
export function TelemetryExceptionSummary(props: Readonly<{
  active: boolean;
  environmentId: string;
  lifetime: ServerAccountScopeLifetime | null;
  retainedLastSeen?: number | null;
}>) {
  const router = useRouter();
  const { projection, accountLifetime } = useAppShellPluginUiDeclarationSources();
  const serverId = props.lifetime?.scope.serverId;
  const declaration = readPluginUiResourceProjection(projection?.resourcesById, RESOURCE);
  const binding = accountLifetime && serverId && areServerAccountScopesEqual(props.lifetime?.scope, accountLifetime.scope) && declaration
    ? resolvePluginContextualResourceBinding({ projection, accountLifetime, machineId: null, serverId,
      requireReadAuthority: true, isCurrent: accountLifetime.isCurrent }, declaration, {
      kind: 'surface', mountInstanceKey: `environment-issues:${props.environmentId}`,
      launchInput: { entity: 'service', serverId, environmentIds: [props.environmentId], includeTrend: false },
    })
    : null;
  const render = (snapshot: PluginUiResourceSnapshot | null, refresh?: () => unknown) => {
    const facts = readExceptionFacts(snapshot);
    const count = facts?.[TELEMETRY_OPEN_ISSUES_FIELD.id]?.value;
    const savedLastSeen = facts?.[TELEMETRY_LAST_ISSUE_SEEN_FACT_ID]?.value;
    const entrySegment = facts?.[TELEMETRY_LATEST_ISSUE_ENTRY_FACT_ID]?.value;
    const entry = typeof entrySegment === 'string' ? readTriageEntryRouteSegmentV1(entrySegment) : null;
    const { retainedLastSeen } = props;
    const lastSeen = retainedLastSeen == null ? savedLastSeen
      : typeof savedLastSeen === 'number' ? Math.max(savedLastSeen, retainedLastSeen) : retainedLastSeen;
    return <>
      <Item testID="project-deployments.telemetry.exceptions.summary"
        title={typeof count === 'number' ? t('deploymentTelemetry.exceptionSummary.openCount', { count }) : t('deploymentTelemetry.sheet.exceptions')}
        subtitle={typeof lastSeen === 'number' ? t('deploymentTelemetry.exceptionSummary.lastSeen', {
          time: formatWithCachedDateTimeFormatter(lastSeen, getPreferredLanguage(), { dateStyle: 'medium', timeStyle: 'short' }),
        }) : undefined}
        mode="info"
        showChevron={false}
        // The action is wider than a value: on a phone it moves beneath the summary (DESIGN "Phones recompose").
        accessoryLayout="adaptive"
        rightElementOutsidePressable
        rightElement={entry ? <TextLinkButton testID="project-deployments.telemetry.exceptions.open-triage"
          label={t('deploymentTelemetry.exceptionSummary.openTriage')}
          onPress={() => router.push(buildPluginAppPageRoutePath(buildTriageEntryPageV1(entry)) as never)} /> : undefined}
      />
      {snapshot?.error || snapshot?.freshness === 'stale' ? <SurfaceFreshnessLine
        reason={snapshot.error?.message ?? t('common.unavailable')}
        action={refresh ? { label: t('common.retry'), onPress: refresh } : undefined}
      /> : null}
    </>;
  };
  return binding ? <PluginContextualResourceState active={props.active} binding={binding} resource={RESOURCE}>
    {(snapshot, controls) => render(snapshot, controls.refresh)}
  </PluginContextualResourceState> : render(null);
}
