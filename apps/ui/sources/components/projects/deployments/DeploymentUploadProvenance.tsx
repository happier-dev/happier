import * as React from 'react';
import type { DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/v1';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

type UploadProvenance = NonNullable<DeploymentReceiptDetailV1['content']['platform']>['observation']['uploadProvenance'];

/** The receipt and its build logs show the same captured upload evidence, without another read. */
export function DeploymentUploadProvenance(props: Readonly<{ provenance: UploadProvenance; testID: string }>) {
  const evidence = props.provenance;
  if (!evidence) return null;
  const build = evidence.build;
  return <ItemGroup testID={props.testID} title={t('projects.deployments.platformLink.upload')}
    description={t(build.location === 'controller'
      ? 'projects.deployments.platformLink.controllerBuild' : 'projects.deployments.platformLink.providerBuild')}>
    <Item testID={`${props.testID}.source`} title={t('projects.deployments.platformLink.sourceManifest')}
      subtitle={evidence.sourceManifestFingerprint} showChevron={false} />
    {build.location === 'controller' ? <>
      <Item testID={`${props.testID}.image`} title={t('projects.deployments.platformLink.buildImage')}
        subtitle={build.image} showChevron={false} />
      <Item testID={`${props.testID}.toolchain`} title={t('projects.deployments.platformLink.buildToolchain')}
        subtitle={`${build.toolchain.name} ${build.toolchain.version}`} showChevron={false} />
      <Item testID={`${props.testID}.output`} title={t('projects.deployments.platformLink.buildOutputManifest')}
        subtitle={build.outputManifestFingerprint} showChevron={false} />
    </> : null}
  </ItemGroup>;
}
