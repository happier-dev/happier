import * as React from 'react';
import {
  isDeploymentDomainAttachedV1,
  projectDeploymentDomainFactsV1,
  type DeploymentReadControllerV1,
  type DeploymentReadDemandV1,
} from '@happier-dev/deployments';

import { useManagedInventory } from '@/components/store/inventory/useManagedInventory';
import { InboxArtifactSourceBoundary } from '@/hooks/inbox/useInboxArtifactSource';
import type { ManagedConfiguredCheckRow } from '@/components/store/inventory/managedOperationalInventory';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import { databaseEngineTitle } from './databasePresentation';
import { deploymentDomainAttention } from './deploymentDomainAttention';
import {
  buildDeploymentEnvironmentHref,
  SERVICES_ROUTE,
} from './deploymentNavigation';
import {
  DeploymentTreeRow,
  type DeploymentRowState,
  type DeploymentTreeRowKind,
} from './rows/DeploymentEnvironmentRow';
import {
  readServiceCheckFacts,
  serviceCheckListFacts,
  serviceCheckStatusTone,
  serviceCheckStatusWord,
} from './serviceCheckPresentation';
import {
  useDeploymentDataServicePage,
  useDeploymentDomainPage,
} from './useDeploymentReads';

const CHECK_KINDS = ['configuredCheck'] as const;

/** One row of a type section: what it is, its one line and where a press goes. */
type TypeRow = Readonly<{
  key: string;
  kind: DeploymentTreeRowKind;
  title: string;
  titleQualifier?: string | null;
  fact: string | null;
  state: DeploymentRowState | null;
  href: string | null;
}>;

/**
 * The Services column By type (owner 2026-11-16 10:20Z; lab monitoring-1115 monC): after Apps (the Projects tree the
 * column draws), Databases, Domains and Checks each stand as a section, only when they have items. Every row is the
 * one Environment row (`DeploymentTreeRow`); its end is its state (the compact dot) or its one quiet fact. The reads
 * mount only while this grouping is shown.
 */
export function ServicesColumnTypeSections(props: TypeSectionsProps) {
  // The Checks read (managed inventory) reads through the Inbox Artifact source; the boundary reuses an existing one.
  return (
    <InboxArtifactSourceBoundary>
      <TypeSectionsBody {...props} />
    </InboxArtifactSourceBoundary>
  );
}

type TypeSectionsProps = Readonly<{
  controller: DeploymentReadControllerV1 | null;
  demand: DeploymentReadDemandV1;
  scope: ServerAccountScope | null;
  serverId: string | null;
  needle: string;
  onNavigate: (href: string) => void;
}>;

function TypeSectionsBody(props: TypeSectionsProps) {
  const { serverId, needle } = props;
  const databases = useDeploymentDataServicePage(
    props.controller,
    props.demand,
  );
  const domains = useDeploymentDomainPage(props.controller, props.demand);
  const checksQuery = React.useMemo(
    () => ({
      scope: props.scope,
      machine: null,
      projectKey: null,
      presented: true,
      kinds: CHECK_KINDS,
    }),
    [props.scope],
  );
  const inventory = useManagedInventory(checksQuery);
  const databaseItems = databases.snapshot.value?.items;
  const domainItems = domains.snapshot.value?.items;
  const sections = React.useMemo(() => {
    const matches = (row: TypeRow) =>
      !needle || row.title.toLocaleLowerCase().includes(needle);
    // A database ends with its engine (lab monC "PostgreSQL 16") and opens on its Environment's page.
    const databaseRows: TypeRow[] = (databaseItems ?? []).flatMap((item) =>
      (item.databaseSizes ?? []).map((database) => {
        const declared = item.content.template?.data?.find(
          (data) => data.service === database.service,
        );
        return {
          key: `${item.environment.id}/${database.service}`,
          kind: 'database' as const,
          title: database.service,
          titleQualifier: item.title,
          fact: declared ? databaseEngineTitle(declared) : null,
          state: null,
          href: serverId
            ? buildDeploymentEnvironmentHref({
                serverId,
                projectSourceId: item.environment.projectSourceId,
                environmentId: item.environment.id,
                database: database.service,
              })
            : null,
        };
      }),
    );
    // The name tells rows apart: a database name several Environments share is qualified by its Environment's name.
    const repeated = new Set(databaseRows.map((row) => row.title).filter((title, index, titles) => titles.indexOf(title) !== index));
    const namedDatabaseRows = databaseRows.map((row) => (repeated.has(row.title) ? row : { ...row, titleQualifier: null }));
    // A domain says its state when it needs the person (the Domain attention owner), and opens its Environment's Domains.
    const domainRows: TypeRow[] = (domainItems ?? []).map((item) => {
      const attached = isDeploymentDomainAttachedV1(
        item.domain,
        item.environment,
      );
      const attention = deploymentDomainAttention(
        item,
        projectDeploymentDomainFactsV1(
          item.domain,
          props.scope?.accountId ?? '',
          null,
        ).state,
        attached,
      );
      return {
        key: `${item.environment.id}/${item.content.hostname}`,
        kind: 'domain' as const,
        title: item.content.hostname,
        fact: null,
        state: attention
          ? { tone: attention.variant, text: attention.label }
          : null,
        href: serverId
          ? buildDeploymentEnvironmentHref({
              serverId,
              projectSourceId: item.environment.projectSourceId,
              environmentId: item.environment.id,
              tab: 'domains',
            })
          : null,
      };
    });
    // A check says its state while it fails or is switched off (the Check presentation owner); its list is Services → Checks.
    const checkRows: TypeRow[] = inventory.rows
      .filter(
        (row): row is ManagedConfiguredCheckRow =>
          row.kind === 'configuredCheck',
      )
      .map((row) => {
        const status = readServiceCheckFacts(row.lastResults).status;
        const tone = serviceCheckStatusTone(status);
        const state: DeploymentRowState | null = !row.native.enabled
          ? { tone: 'muted', text: t('projects.deployments.healthNotChecked') }
          : tone
            ? { tone, text: serviceCheckStatusWord(status) }
            : null;
        return {
          key: row.key,
          kind: 'check' as const,
          title: serviceCheckListFacts(row).title ?? row.native.name,
          fact: null,
          state,
          href: `${SERVICES_ROUTE}?view=checks`,
        };
      });
    return (
      [
        [
          'databases',
          t('projects.deployments.services.databases'),
          namedDatabaseRows,
        ],
        ['domains', t('projects.deployments.services.domains'), domainRows],
        ['checks', t('projects.deployments.services.checks'), checkRows],
      ] as const
    )
      .map(([id, title, rows]) => ({ id, title, rows: rows.filter(matches) }))
      .filter((section) => section.rows.length > 0);
  }, [
    databaseItems,
    domainItems,
    inventory.rows,
    needle,
    props.scope?.accountId,
    serverId,
  ]);
  return (
    <>
      {sections.map((section) => (
        <React.Fragment key={section.id}>
          <CollectionListGroupLabel title={section.title} />
          {section.rows.map((row) => (
            <DeploymentTreeRow
              key={row.key}
              testID={`services-column:${row.kind}:${row.key}`}
              row={{
                kind: row.kind,
                title: row.title,
                titleQualifier: row.titleQualifier ?? null,
                state: row.state,
                fact: row.fact,
              }}
              href={row.href}
              selected={false}
              onPress={() => {
                if (row.href) props.onNavigate(row.href);
              }}
            />
          ))}
        </React.Fragment>
      ))}
    </>
  );
}
