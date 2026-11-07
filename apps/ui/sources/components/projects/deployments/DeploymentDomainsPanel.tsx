import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { DeploymentDomainContentV1 } from '@happier-dev/deployment-protocol/v1';
import type {
  DeploymentReadControllerV1,
  DeploymentReadDemandV1,
} from '@happier-dev/deployments';

import { ManagedSectionCount } from '@/components/settings/machines/managed/ManagedSectionCount';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { InlineAddExpander } from '@/components/ui/forms/InlineAddExpander';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { useDeploymentChangePress } from './deploymentActionOutcome';
import type { createDeploymentActions } from './deploymentActions';
import {
  DeployOutcomeBanner,
  type DeploymentReviewHandle,
} from './DeploymentEnvironmentDetail';
import { DeploymentTabState } from './DeploymentTabState';
import { useDeploymentEnvironmentDomains } from './useDeploymentReads';
import { DeploymentDomainRow, type DomainItem } from './DeploymentDomainRow';

type DomainActions = Pick<
  ReturnType<typeof createDeploymentActions>,
  'addDomain' | 'removeDomain' | 'verifyDomain'
>;

/** What the page can change here: the Action owner's Domain Actions and the revisions they are admitted against. */
export type DeploymentDomainEditing = Readonly<{
  actions: DomainActions;
  environmentRevision: number;
  /** The runtime target the addresses route to; Add domain needs one. */
  targetLink: Readonly<{ id: string; revision: number }> | null;
  review: DeploymentReviewHandle;
  /** Names the Machine a held review waits on. */
  machine: string;
  /** A settled change moved the Environment's revision: re-read it before the next press. */
  onChanged: () => void;
}>;

/**
 * Environment → Domains (lab r3 `domains/routing`): one row per address, saying which service and port it reaches.
 * A healthy address is quiet; one still being set up, needing a look or failing says so on its row. DNS, the
 * certificate's renewal and the outside check are not published per Domain yet, so they are not drawn.
 */
export function DeploymentDomainsPanel(
  props: Readonly<{
    controller: DeploymentReadControllerV1;
    environmentId: string;
    demand: DeploymentReadDemandV1;
    phone?: boolean;
    /** Absent where the page cannot write: the addresses stay read-only. */
    editing?: DeploymentDomainEditing | null;
  }>,
) {
  const domains = useDeploymentEnvironmentDomains(
    props.controller,
    props.environmentId,
    props.demand,
  );
  const { items } = domains.result;
  const { editing } = props;
  const [adding, setAdding] = React.useState(false);
  const refresh = domains.refresh;
  const onSettled = React.useCallback(() => {
    editing?.onChanged();
    void refresh();
  }, [editing, refresh]);
  const { running, outcome, press } = useDeploymentChangePress(editing?.review ?? null, onSettled);
  const canAdd = editing !== null && editing !== undefined && editing.targetLink !== null;
  const addAction = canAdd && !adding ? (
    <SectionActionButton
      testID="project-deployments.environment.domains.add"
      title={t('projects.deployments.domainAdd')}
      icon="plus"
      onPress={() => setAdding(true)}
    />
  ) : undefined;
  return (
    <ItemGroup
      testID="project-deployments.environment.domains"
      title={t('projects.deployments.tabDomains')}
      titleAccessory={
        items.length > 0 ? (
          <ManagedSectionCount count={items.length} />
        ) : undefined
      }
      description={t('projects.deployments.domainsDescription')}
      action={addAction}
    >
      {outcome && editing ? (
        <DeployOutcomeBanner
          outcome={outcome}
          pending={outcome.kind === 'approval' && editing.review.pendingId === outcome.artifactId}
          machine={editing.machine}
          onOpenReview={editing.review.open}
          copy="domain"
        />
      ) : null}
      {adding && editing?.targetLink ? (
        <DomainAddForm
          phone={props.phone === true}
          busy={running}
          taken={items.map((item) => item.content.hostname)}
          onCancel={() => setAdding(false)}
          onAdd={async (content) => {
            const link = editing.targetLink!;
            const added = await press(() => editing.actions.addDomain({
              environmentId: props.environmentId,
              expectedRevision: editing.environmentRevision,
              targetLinkId: link.id,
              expectedTargetLinkRevision: link.revision,
              content,
            }));
            if (added) setAdding(false);
          }}
        />
      ) : null}
      {items.map(item => (
        <DeploymentDomainRow
          key={item.domain.id}
          item={item}
          accountId={props.controller.scope.accountId}
          demand={props.demand}
          disabled={running}
          onVerify={editing ? () => { void press(() => editing.actions.verifyDomain(domainOperands(props.environmentId, editing, item))); } : undefined}
          onRemove={editing ? () => { void press(() => editing.actions.removeDomain(domainOperands(props.environmentId, editing, item))); } : undefined}
        />
      ))}
      <DeploymentTabState
        result={domains.result}
        testID="project-deployments.environment.domains"
        errorTitle={t('projects.deployments.domainsErrorTitle')}
        emptyTitle={t('projects.deployments.domainsEmpty')}
      />
      {domains.hasPreviousPage || domains.hasNextPage ? (
        <View style={styles.paging}>
          {domains.hasPreviousPage ? (
            <SectionActionButton
              testID="project-deployments.environment.domains.previous"
              title={t('projects.deployments.pagePrevious')}
              icon="caret-left"
              onPress={domains.previousPage}
            />
          ) : null}
          {domains.hasNextPage ? (
            <SectionActionButton
              testID="project-deployments.environment.domains.next"
              title={t('projects.deployments.pageNext')}
              icon="caret-right"
              onPress={domains.nextPage}
            />
          ) : null}
        </View>
      ) : null}
    </ItemGroup>
  );
}

/** The exact address and the revisions a Remove or Check again is admitted against. */
function domainOperands(environmentId: string, editing: DeploymentDomainEditing, item: DomainItem) {
  return {
    environmentId,
    domainId: item.domain.id,
    expectedRevision: editing.environmentRevision,
    expectedDomainRevision: item.domain.revision,
  };
}

/**
 * Add a domain (lab r3 `domains/add`): the address, then where it leads — service, container port and path on one
 * line on wide screens — then the page Happier checks from outside. Add domain stays off until the address can work.
 */
function DomainAddForm(
  props: Readonly<{
    phone: boolean;
    busy: boolean;
    taken: readonly string[];
    onCancel: () => void;
    onAdd: (content: DeploymentDomainContentV1) => void | Promise<void>;
  }>,
) {
  const [hostname, setHostname] = React.useState('');
  const [service, setService] = React.useState('');
  const [port, setPort] = React.useState('');
  const [path, setPath] = React.useState('');
  const [checkPath, setCheckPath] = React.useState('/');
  const host = hostname.trim().toLowerCase();
  const containerPort = Number(port);
  const portValid = /^\d+$/.test(port) && containerPort >= 1 && containerPort <= 65535;
  const routePath = path.trim();
  const probePath = checkPath.trim();
  const duplicate = props.taken.includes(host);
  const pathValid = routePath === '' || routePath.startsWith('/');
  const probeValid = probePath.startsWith('/');
  const ready = host.length > 0 && !duplicate && service.trim().length > 0 && portValid && pathValid && probeValid && !props.busy;
  return (
    <InlineAddExpander
      isOpen
      onOpenChange={(next) => {
        if (!next) props.onCancel();
      }}
      title={t('projects.deployments.domainAddTitle')}
      trigger={null}
      onCancel={props.onCancel}
      onSave={() => {
        if (!ready) return;
        void props.onAdd({
          hostname: host,
          target: {
            service: service.trim(),
            containerPort,
            ...(routePath ? { path: routePath } : {}),
          },
          healthCheck: { path: probePath, expectStatus: 200 },
        });
      }}
      saveDisabled={!ready}
      cancelLabel={t('common.cancel')}
      saveLabel={t('projects.deployments.domainAdd')}
      saveTestID="project-deployments.environment.domains.add.save"
      cancelTestID="project-deployments.environment.domains.add.cancel"
    >
      <View style={styles.form}>
        <FieldItem label={t('projects.deployments.domainFieldHost')}>
          <FieldTextInput
            testID="project-deployments.environment.domains.add.host"
            value={hostname}
            onChangeText={setHostname}
            autoCapitalize="none"
            autoFocus
            accessibilityLabel={t('projects.deployments.domainFieldHost')}
            placeholder="docs.example.com"
            error={duplicate ? t('projects.deployments.domainExists') : null}
          />
        </FieldItem>
        <View style={props.phone ? styles.stack : styles.route}>
          <FieldItem label={t('projects.deployments.domainFieldService')} style={props.phone ? undefined : styles.routeService}>
            <FieldTextInput
              testID="project-deployments.environment.domains.add.service"
              value={service}
              onChangeText={setService}
              monospace
              autoCapitalize="none"
              accessibilityLabel={t('projects.deployments.domainFieldService')}
              placeholder="web"
            />
          </FieldItem>
          <FieldItem label={t('projects.deployments.domainFieldPort')} style={props.phone ? undefined : styles.routePort}>
            <FieldTextInput
              testID="project-deployments.environment.domains.add.port"
              value={port}
              onChangeText={(next) => setPort(next.replace(/[^0-9]/g, ''))}
              monospace
              keyboardType="number-pad"
              accessibilityLabel={t('projects.deployments.domainFieldPort')}
              placeholder="3000"
            />
          </FieldItem>
          <FieldItem
            label={t('projects.deployments.domainFieldPath')}
            supportingText={t('projects.deployments.domainPathHint')}
            style={props.phone ? undefined : styles.routePath}
          >
            <FieldTextInput
              testID="project-deployments.environment.domains.add.path"
              value={path}
              onChangeText={setPath}
              monospace
              autoCapitalize="none"
              accessibilityLabel={t('projects.deployments.domainFieldPath')}
              placeholder={t('projects.deployments.domainAllPaths')}
            />
          </FieldItem>
        </View>
        <FieldItem
          label={t('projects.deployments.domainFieldCheck')}
          supportingText={t('projects.deployments.domainCheckHint')}
        >
          <FieldTextInput
            testID="project-deployments.environment.domains.add.check"
            value={checkPath}
            onChangeText={setCheckPath}
            monospace
            autoCapitalize="none"
            accessibilityLabel={t('projects.deployments.domainFieldCheck')}
          />
        </FieldItem>
      </View>
    </InlineAddExpander>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.space.s12 },
  stack: { gap: theme.space.s12 },
  // Service, port and path share one line on wide screens (lab 1.2 : .8 : 1); phones stack them.
  route: { flexDirection: 'row', gap: theme.space.s12, alignItems: 'flex-start' },
  routeService: { flex: 1.2 },
  routePort: { flex: 0.8 },
  routePath: { flex: 1 },
  paging: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: theme.space.s8,
    paddingVertical: theme.space.s8,
  },
}));
