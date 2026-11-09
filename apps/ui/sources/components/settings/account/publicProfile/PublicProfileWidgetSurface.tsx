import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPublicProfileWidget, HappierPublicProfileDataProvider } from '@happier-dev/plugin-ui/components';
import { type HappierPublicProfileLabels, type HappierPublicProfileOwner, type HappierPublicProfileUsageHost } from '@happier-dev/plugin-ui/presentation';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, type PublicProfileSnapshotV1 } from '@happier-dev/protocol/account/publicProfile';
import { createPublicProfileProjector, type PublicProfileDataProjection, type projectPublicProfilePreview } from '@happier-dev/protocol/account/projectPublicProfile';
import { PublicProfilePreviewResultV1Schema } from '@happier-dev/protocol/account/publicProfileIntents';
import { resolveWidgetPublicSnapshotPresentationV1, type WidgetInstanceV1, type WidgetSizeV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';
import { publicProfilePageLabels, usePublicProfileUsageHost } from './publicProfilePresentation';
import { usePublicProfileOwnerRead } from './usePublicProfileOwnerRead';
import { DEFAULT_PUBLIC_PROFILE_QUERY, publicProfileRecordPeriod } from './publicProfileDraft';

type PreviewSource = Omit<Parameters<typeof projectPublicProfilePreview>[0], 'layout'>;
/**
 * The page's one preview for every placed block. `unavailable` is the page's own state (its period line
 * says why), so blocks keep their slots quietly instead of each reading again or naming another cause.
 */
export type PublicProfileWidgetPreview =
  | Readonly<{ kind: 'ready'; source: PreviewSource; labels: HappierPublicProfileLabels; usage?: HappierPublicProfileUsageHost;
      /** The editor already owns the policy projection; standalone setup admits its source here. */
      projection?: PublicProfileDataProjection;
      /** Edit on the owner's page: the same in-place hidden presentation the page itself draws for its owner. */
      owner?: HappierPublicProfileOwner }>
  | Readonly<{ kind: 'unavailable'; reason: string }>;
const PublicProfileWidgetPreviewContext = React.createContext<PublicProfileWidgetPreview | null>(null);

export function PublicProfileWidgetPreviewProvider(props: Readonly<{ value: PublicProfileWidgetPreview | null; children: React.ReactNode }>) {
  return props.value?.kind === 'ready' ? <ReadyPublicProfileWidgetPreview value={props.value}>{props.children}</ReadyPublicProfileWidgetPreview>
    : <PublicProfileWidgetPreviewContext.Provider value={props.value}>{props.children}</PublicProfileWidgetPreviewContext.Provider>;
}

function ReadyPublicProfileWidgetPreview(props: Readonly<{
  value: Extract<PublicProfileWidgetPreview, { kind: 'ready' }>; children: React.ReactNode;
}>) {
  const { source } = props.value;
  const projector = React.useMemo(() => props.value.projection ? null : createPublicProfileProjector(source.snapshot),
    [source.snapshot, props.value.projection]);
  const projection = React.useMemo(() => props.value.projection ?? projector?.project(source) ?? null,
    [props.value.projection, projector, source.context, source.policy, source.metadata]);
  const view = React.useMemo(() => projection ? { ...projection.view, layout: { v: 1 as const, items: [] } } : null, [projection]);
  if (!projection || !view) return <PublicProfileWidgetPreviewContext.Provider value={null}>{props.children}</PublicProfileWidgetPreviewContext.Provider>;
  return <PublicProfileWidgetPreviewContext.Provider value={{ ...props.value, projection }}>
    <HappierPublicProfileDataProvider view={view} usage={props.value.usage}>{props.children}</HappierPublicProfileDataProvider>
  </PublicProfileWidgetPreviewContext.Provider>;
}

/** A whole area/group shares its existing preview owner; standalone setup reads it once. */
export function PublicProfileWidgetPreviewBoundary(props: Readonly<{ scope: WidgetSurfaceRefV1; children: React.ReactNode }>) {
  const preview = React.useContext(PublicProfileWidgetPreviewContext);
  return preview ? props.children : <ReadPublicProfileWidgetPreview key={JSON.stringify([props.scope.serverId, props.scope.accountId])}
    scope={props.scope}>{props.children}</ReadPublicProfileWidgetPreview>;
}

function ReadPublicProfileWidgetPreview(props: Readonly<{ scope: WidgetSurfaceRefV1; children: React.ReactNode }>) {
  const execution = useMountedActionExecution(props.scope);
  return <PublicProfileWidgetPreviewRead execution={execution} scope={props.scope}>{props.children}</PublicProfileWidgetPreviewRead>;
}

/** The standalone read for a setup opened outside the page: one owner read and, without a snapshot, one preview. */
export function PublicProfileWidgetPreviewRead(props: Readonly<{
  execution: Pick<ReturnType<typeof useMountedActionExecution>, 'ready' | 'executeValue'>;
  scope: AccountSettingsScope; children: React.ReactNode;
}>) {
  const { execution } = props;
  const { state } = usePublicProfileOwnerRead(execution, props.scope);
  const read = state.kind === 'ready' ? state.read : null;
  const record = read?.kind === 'ready' ? read.record : null;
  const [local, setLocal] = React.useState<PublicProfileSnapshotV1 | null>(null);
  const [reason, setReason] = React.useState<string | null>(null);
  const latest = React.useRef(execution);
  latest.current = execution;
  React.useEffect(() => {
    if (!read || record?.snapshot) return;
    let current = true;
    void latest.current.executeValue('account.public_profile.preview', {
      policy: record?.policy ?? DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadataSelection: {},
      query: record?.query ?? DEFAULT_PUBLIC_PROFILE_QUERY, layout: { v: 1, items: [] },
      appearance: { atmosphere: { source: 'none' }, theme: 'auto' },
    }).then(value => {
      if (!current) return;
      const result = PublicProfilePreviewResultV1Schema.parse(value);
      if (result.kind === 'ready') setLocal(result.view.snapshot);
      else setReason(t(`publicIdentity.profile.reasons.${result.reason}`));
    }).catch(() => { if (current) setReason(t('publicIdentity.profile.reasons.preparation_unavailable')); });
    return () => { current = false; };
  }, [read, record]);
  const snapshot = record?.snapshot ?? local;
  const usage = usePublicProfileUsageHost(props.scope.serverId, snapshot?.period ?? null);
  const failed = state.kind === 'failed' ? t('publicIdentity.profile.reasons.preparation_unavailable') : reason;
  // The setup's own controls (size, inputs) never wait for the page: only its preview slot does.
  const preview = React.useMemo<PublicProfileWidgetPreview>(() => read && snapshot ? {
    kind: 'ready' as const,
    source: { context: read.context, snapshot, policy: record?.policy ?? DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      metadata: record?.metadata ?? {}, appearance: { atmosphere: { source: 'none' as const }, theme: 'auto' as const } },
    labels: publicProfilePageLabels(read.context, snapshot, null, publicProfileRecordPeriod(record)), usage,
  } : { kind: 'unavailable', reason: failed ?? t('publicIdentity.editor.preparing') }, [read, snapshot, record, usage, failed]);
  return <PublicProfileWidgetPreviewProvider value={preview}>{props.children}</PublicProfileWidgetPreviewProvider>;
}

/** Public-area mounts can draw only an admitted inert template/shared body, never the private renderer. */
export function PublicProfileWidgetSurface(props: Readonly<{
  instance: WidgetInstanceV1; descriptor: WidgetCandidate | null; size?: WidgetSizeV1; testID: string;
}>) {
  const shared = React.useContext(PublicProfileWidgetPreviewContext);
  if (shared?.kind === 'unavailable') return <View testID={`${props.testID}.awaiting`} accessible
    accessibilityLabel={shared.reason} style={styles.awaiting}><Text variant="meta" style={styles.dash}>—</Text></View>;
  const preview = shared;
  const presentation = props.descriptor && resolveWidgetPublicSnapshotPresentationV1(props.instance, props.descriptor);
  const size = props.size ?? props.descriptor?.sizeDeclaration.defaultSize;
  const view = preview?.projection && presentation && size ? { ...preview.projection.view,
    layout: preview.projection.projectLayout({ v: 1, items: [{ kind: 'widget', id: props.instance.id, size, frameStyle: 'plain', presentation }] }),
  } : null;
  if (!view || !preview) return <SurfaceStateCard testID={props.testID} kind="unavailable" title={t('publicIdentity.page.blockUnavailable')} />;
  return <CorePluginUiPresentationScope><HappierPublicProfileWidget view={view} widgetId={props.instance.id}
    labels={preview.labels} usage={preview.usage} testID={props.testID}
    {...(preview.owner ? { owner: preview.owner } : {})} /></CorePluginUiPresentationScope>;
}

const styles = StyleSheet.create((theme) => ({
  awaiting: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: theme.space.s24 },
  dash: { color: theme.colors.text.tertiary },
}));
