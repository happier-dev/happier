import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import {
  DeploymentEnvironmentDraft,
  type DeploymentDraftFrame,
  type DeploymentDraftStepsHost,
} from '@/components/projects/deployments/DeploymentEnvironmentDraft';
import { useDeploymentProjectChoice } from '@/components/projects/deployments/DeploymentProjectChoice';
import { createDeploymentActions } from '@/components/projects/deployments/deploymentActions';
import {
  buildDeploymentEnvironmentHref,
  type DeploymentNewDefinitionKind,
} from '@/components/projects/deployments/deploymentNavigation';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { FieldLayout, FieldValue } from '@/components/ui/lists/FieldRow';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { readStoreAppTemplate } from '@/components/store/presets/storePresetDoor';
import { useRegistryItem } from '@/registries/useRegistryItem';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

/**
 * What Deploy an app deploys once its source step is answered: a Project's repository, a stored definition, or a
 * catalog app (its exact pin read from the registry). `targetId` pre-selects Where; the person can still change it.
 */
export type NewAppDeploySource =
  | Readonly<{ kind: 'repository'; projectSourceId: string }>
  | Readonly<{
      kind: 'definition';
      definitionKind: DeploymentNewDefinitionKind;
    }>
  | Readonly<{ kind: 'catalogApp'; app: Readonly<{ sourceId: string; itemId: string }>; targetId?: string }>;

/**
 * Deploy an app's Where → Configure → Review (journey-deploy D3): the one Environment draft, hosted as steps inside
 * the dialog. The draft owns every decision and Action; this host only binds its Home and says where it goes after.
 */
export function NewAppDeploySteps(
  props: Readonly<{
    serverId: string;
    source: NewAppDeploySource;
    /** A "Deploy an app here" door's Machine; the person can still choose another. */
    previewEnvironmentId?: string | null;
    machineId: string | null;
    phone: boolean;
    steps: DeploymentDraftStepsHost;
    /** Closes the flow before it navigates (a dialog steps aside; a page has nothing to close). */
    onLeave: () => void;
  }>,
) {
  const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
  if (!binding)
    return (
      <SurfaceStateCard
        testID="newApp.deploy.loading"
        kind="loading"
        layout="inline"
        title={t('common.loading')}
      />
    );
  return props.source.kind === 'repository' ? (
    <RepositoryDeploy
      key={`${binding.scope.serverId}:${binding.scope.accountId}`}
      {...props}
      lifetime={binding}
      projectSourceId={props.source.projectSourceId}
    />
  ) : props.source.kind === 'catalogApp' ? (
    <CatalogAppDeploy
      key={`${binding.scope.serverId}:${binding.scope.accountId}`}
      {...props}
      lifetime={binding}
      app={props.source.app}
      targetId={props.source.targetId ?? null}
    />
  ) : (
    <DefinitionDeploy
      key={`${binding.scope.serverId}:${binding.scope.accountId}`}
      {...props}
      lifetime={binding}
      definitionKind={props.source.definitionKind}
    />
  );
}

type BoundProps = Readonly<{
  lifetime: ServerAccountScopeLifetime;
  machineId: string | null;
  previewEnvironmentId?: string | null;
  phone: boolean;
  steps: DeploymentDraftStepsHost;
  onLeave: () => void;
}>;

function useDeployExits(props: BoundProps) {
  const router = useRouter();
  const { lifetime, onLeave } = props;
  const leaveTo = React.useCallback(
    (href: string) => {
      onLeave();
      router.push(href as never);
    },
    [onLeave, router],
  );
  const onApprovalRequested = React.useCallback(
    (artifactId: string) => {
      leaveTo(buildApprovalHref(artifactId, lifetime.scope.serverId));
    },
    [leaveTo, lifetime.scope.serverId],
  );
  return { leaveTo, onApprovalRequested };
}

function RepositoryDeploy(
  props: BoundProps & Readonly<{ projectSourceId: string }>,
) {
  const { lifetime, projectSourceId } = props;
  const actions = React.useMemo(
    () => createDeploymentActions(lifetime, projectSourceId),
    [lifetime, projectSourceId],
  );
  const { leaveTo, onApprovalRequested } = useDeployExits(props);
  return (
    <DeploymentEnvironmentDraft
      lifetime={lifetime}
      sourceId={projectSourceId}
      phone={props.phone}
      actions={actions}
      platformAvailable
      initialMachineId={props.machineId}
      previewEnvironmentId={props.previewEnvironmentId}
      steps={props.steps}
      onApprovalRequested={onApprovalRequested}
      onDiscard={props.onLeave}
      onSaved={(environmentId, next) =>
        leaveTo(
          buildDeploymentEnvironmentHref({
            serverId: lifetime.scope.serverId,
            projectSourceId,
            environmentId,
            ...(next?.tab ? { tab: next.tab } : {}),
          }),
        )
      }
    />
  );
}

function DefinitionDeploy(
  props: BoundProps & Readonly<{ definitionKind: DeploymentNewDefinitionKind }>,
) {
  const { lifetime } = props;
  const projectChoice = useDeploymentProjectChoice({
    lifetime,
    initiallyNew: true,
  });
  const actions = React.useMemo(
    () => createDeploymentActions(lifetime),
    [lifetime],
  );
  const { leaveTo, onApprovalRequested } = useDeployExits(props);
  return (
    <DeploymentEnvironmentDraft
      lifetime={lifetime}
      sourceId={null}
      projectChoice={projectChoice}
      definitionKind={props.definitionKind}
      phone={props.phone}
      actions={actions}
      // Every source reads the declared platforms: one it can't use is listed as unable to run it (whereM).
      platformAvailable
      initialMachineId={props.machineId}
      steps={props.steps}
      onApprovalRequested={onApprovalRequested}
      onDiscard={props.onLeave}
      onSaved={(environmentId, next) => {
        const selection = projectChoice.selection;
        const projectSourceId =
          next?.projectSourceId ??
          (selection && 'projectSourceId' in selection
            ? selection.projectSourceId
            : null);
        if (projectSourceId)
          leaveTo(
            buildDeploymentEnvironmentHref({
              serverId: lifetime.scope.serverId,
              projectSourceId,
              environmentId,
              ...(next?.tab ? { tab: next.tab } : {}),
            }),
          );
        else props.onLeave();
      }}
    />
  );
}

/**
 * The registry item read supplies the App's exact pin and declared addresses to the draft.
 */
function CatalogAppDeploy(props: BoundProps & Readonly<{ app: Readonly<{ sourceId: string; itemId: string }>; targetId: string | null }>) {
  const read = useRegistryItem({ kind: 'app', sourceId: props.app.sourceId, itemId: props.app.itemId }, true, { scope: props.lifetime.scope });
  if (!read.item) {
    return read.error && !read.loading
      // One line under the summary, as the start step's catalog outage reads; the read's own error stays behind Details.
      ? <SurfaceStateCard testID="newApp.deploy.catalogFailed" kind="error" size="line" title={t('capabilities.store.listing.failed')}
        diagnosticCode={read.error} action={{ label: t('common.retry'), onPress: read.refresh }} />
      : <SurfaceStateCard testID="newApp.deploy.loading" kind="loading" layout="inline" title={t('common.loading')} />;
  }
  const template = readStoreAppTemplate(read.item);
  if (!template) return <SurfaceStateCard testID="newApp.deploy.catalogUnavailable" kind="unavailable" layout="inline" title={t('common.unavailable')} />;
  return <CatalogAppDraft {...props} templateRef={template.templateRef} domains={template.app.domains} title={read.item.summary.title} />;
}

type CatalogTemplate = NonNullable<ReturnType<typeof readStoreAppTemplate>>;

function CatalogAppDraft(props: BoundProps & Readonly<{ templateRef: CatalogTemplate['templateRef'];
  title: string; domains: CatalogTemplate['app']['domains']; targetId: string | null }>) {
  const { lifetime } = props;
  const projectChoice = useDeploymentProjectChoice({ lifetime, initiallyNew: true, initialNewProjectName: props.title });
  const actions = React.useMemo(() => createDeploymentActions(lifetime), [lifetime]);
  const catalogApp = React.useMemo(() => ({ templateRef: props.templateRef, title: props.title, domains: props.domains }),
    [props.templateRef, props.title, props.domains]);
  const { leaveTo, onApprovalRequested } = useDeployExits(props);
  return <DeploymentEnvironmentDraft lifetime={lifetime} sourceId={null} projectChoice={projectChoice} catalogApp={catalogApp}
    phone={props.phone} actions={actions} platformAvailable initialMachineId={props.machineId} initialTargetKey={props.targetId}
    steps={props.steps} onApprovalRequested={onApprovalRequested} onDiscard={props.onLeave}
    onSaved={(environmentId, next) => {
      const selection = projectChoice.selection;
      const projectSourceId = next?.projectSourceId ?? (selection && 'projectSourceId' in selection ? selection.projectSourceId : null);
      if (projectSourceId) leaveTo(buildDeploymentEnvironmentHref({ serverId: lifetime.scope.serverId, projectSourceId,
        environmentId, ...(next?.tab ? { tab: next.tab } : {}) }));
      else props.onLeave();
    }} />;
}

/**
 * The flow's one summary of answered steps (lab `jd-sum`): a label column, the answer, and Change on the same line.
 * Rendered by the host above the step, so every step reads the same facts in the same place.
 */
export function NewAppDeploySummary(
  props: Readonly<{
    phone: boolean;
    /** What deploys: its name, a quiet note (where it comes from) and, for a catalog app, its mark. */
    source: Readonly<{ title: string; note: string | null; mark?: React.ReactNode }>;
    frame: DeploymentDraftFrame | null;
    onChangeSource: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const runsOn =
    props.frame && props.frame.step !== 'where' ? props.frame.runsOn : null;
  return (
    // The summary leads every step: it takes no section space of its own, so it sits under the title band as the
    // start step's search does (one gap under the header in every step, lab jdF-catWhere / jdF-cfg).
    <ItemGroup testID="newApp.deploy.summary" header="none">
      <Item
        mode="info"
        testID="newApp.deploy.summary.source"
        showChevron={false}
        title={
          <FieldLayout label={t('newApp.deploy.source')} columns={!props.phone}>
            {/* One line: the app's mark, its name, then where it comes from (jdF-catWhere / jdF-catCfg); a phone keeps
                the name only (lab: summary facts hidden on phones) (DESIGN-ACCEPT W1). */}
            <View style={summaryStyles.sourceLine}>
              {props.source.mark ?? null}
              <Text numberOfLines={1} style={[summaryStyles.sourceText, { color: theme.colors.text.primary }]}>
                {props.source.title}
                {props.source.note && !props.phone ? (
                  <Text style={{ color: theme.colors.text.secondary }}>{` · ${props.source.note}`}</Text>
                ) : null}
              </Text>
            </View>
          </FieldLayout>
        }
        rightElement={
          <TextLinkButton
            testID="newApp.deploy.changeSource"
            size="meta"
            label={t('newApp.deploy.change')}
            onPress={props.onChangeSource}
          />
        }
      />
      {runsOn && props.frame ? (
        <Item
          mode="info"
          testID="newApp.deploy.summary.runsOn"
          showChevron={false}
          title={
            <FieldLayout
              label={t('newApp.deploy.runsOn')}
              columns={!props.phone}
            >
              <FieldValue
                value={runsOn.title ?? t('newApp.deploy.onMachine')}
              />
            </FieldLayout>
          }
          rightElement={
            <TextLinkButton
              testID="newApp.deploy.changeTarget"
              size="meta"
              label={t('newApp.deploy.change')}
              onPress={props.frame.toWhere}
            />
          }
        />
      ) : null}
    </ItemGroup>
  );
}

const summaryStyles = StyleSheet.create((theme) => ({
  sourceLine: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, minWidth: 0 },
  // The value's role and face, as FieldValue draws it (FieldRow), on one line with its note.
  sourceText: { ...happierPageTextMetrics('rowTitle'), ...Typography.default(), flexShrink: 1, minWidth: 0 },
}));
