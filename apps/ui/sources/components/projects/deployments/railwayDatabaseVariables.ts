import * as React from 'react';
import {
  createDeploymentTargetCatalogV1,
  listDeploymentTargetsFromManifestsV1,
  readDeploymentDatabaseReferenceV1,
  selectDeploymentRuntimeTargetLinkV1,
  type DeploymentEnvironmentReadDetailV1,
} from '@happier-dev/deployments';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import { readPlatformResourceName } from './platformTargetLink';
import { buildPreviewBranchReadInput } from './previewDatabaseBranches';
import { useDeploymentTargetLinkChoices } from './useDeploymentTargetLinkChoices';

const NO_TARGETS = [] as const;

/** Resolve reference eligibility from declarations, then open only those saved database links. */
export function useProviderDatabaseReferenceChoices(detail: DeploymentEnvironmentReadDetailV1 | undefined,
  declarations: readonly Readonly<{ manifest: PluginPortableReleaseManifestV1 }>[] | undefined,
  lifetime: ServerAccountScopeLifetime | null, presented: boolean) {
  const links = detail?.targetLinks;
  const runtimeTargetLinkId = detail?.environment.runtimeTargetLinkId;
  const basis = React.useMemo(() => {
    if (!links || !declarations) return null;
    const runtime = selectDeploymentRuntimeTargetLinkV1({ environment: { runtimeTargetLinkId }, targetLinks: links });
    if (runtime?.source.kind !== 'plugin') return null;
    const runtimeContent = links.find(row => row.targetLink.id === runtime.id)?.content;
    const runtimeProviderIdentity = runtimeContent?.providerIdentity;
    const runtimeProviderEnvironment = runtimeContent?.providerEnvironment;
    if (!runtimeProviderIdentity || !runtimeProviderEnvironment) return null;

    const catalog = createDeploymentTargetCatalogV1(listDeploymentTargetsFromManifestsV1(declarations));
    const runtimeTarget = catalog.read(runtime.source);
    if (!runtimeTarget) return null;
    const targets = links.flatMap(row => {
      const { source, role, deletedAtMs, detachedAtMs, state } = row.targetLink;
      if (role !== 'data' || source.kind !== 'plugin' || state === 'detached'
        || deletedAtMs !== undefined || detachedAtMs !== undefined) return [];
      const dataTarget = catalog.read(source);
      const reference = dataTarget && readDeploymentDatabaseReferenceV1(runtimeTarget, dataTarget, declarations);
      return reference ? [{ ...row, reference }] : [];
    });
    return { targets, runtimeProviderIdentity, runtimeProviderEnvironment };
  }, [links, runtimeTargetLinkId, declarations]);

  const { choices } = useDeploymentTargetLinkChoices({ lifetime, environmentId: detail?.environment.id ?? '',
    targets: basis?.targets ?? NO_TARGETS, presented: Boolean(presented && lifetime && basis?.targets.length) });
  return React.useMemo(() => {
    if (!detail || !basis || !lifetime) return [];
    const openedById = new Map(choices.rows.map(row => [row.targetLink.id, row]));
    return basis.targets.flatMap(({ targetLink, reference }) => {
      const opened = openedById.get(targetLink.id);
      if (!opened || opened.targetLink.revision !== targetLink.revision) return [];
      const data = buildPreviewBranchReadInput(detail, opened, 'connectionSecret.reference');
      if (!data) return [];
      return [{
        id: targetLink.id, ...reference,
        title: readPlatformResourceName(opened.content, opened.title || reference.providerName) ?? reference.providerName,
        input: { ...data, runtimeProviderIdentity: basis.runtimeProviderIdentity,
          runtimeProviderEnvironment: basis.runtimeProviderEnvironment },
      }];
    });
  }, [basis, choices.rows, detail, lifetime]);
}
