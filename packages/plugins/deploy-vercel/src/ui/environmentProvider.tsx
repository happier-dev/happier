import {
  EmptyState, ErrorState, LoadingState, Metadata, defineUiSurface,
  useLivePluginResourceProjection, usePluginTranslation, useSurfaceContext,
} from '@happier-dev/plugin-ui';
import { pluginIdentity, runtimeTargetId } from '../identity.js';

const environmentResource = {
  decode(content: { bytes: Uint8Array }) {
    const payload: { items: { runtimeTargetLink?: {
      source: { kind: string; contribution?: { pluginId: string; localId: string } };
      state: string;
    } | null }[] } = JSON.parse(new TextDecoder().decode(content.bytes));
    const row = payload.items[0];
    if (!row) return null;
    const link = row.runtimeTargetLink;
    const target = link?.source.kind === 'plugin' ? link.source.contribution : undefined;
    return { state: target?.pluginId === pluginIdentity.id && target.localId === runtimeTargetId ? link?.state : undefined };
  },
};

export const renderSurface = defineUiSurface(function EnvironmentProvider() {
  const { target } = useSurfaceContext();
  return target?.kind === 'deploymentEnvironment' ? <VercelProject target={target} /> : null;
});

function VercelProject({ target }: {
  target: Extract<NonNullable<ReturnType<typeof useSurfaceContext>['target']>, { kind: 'deploymentEnvironment' }>;
}) {
  const t = usePluginTranslation();
  const { value: resource, refresh } = useLivePluginResourceProjection({
    hostRead: 'deployments.environments.list',
    input: { serverId: target.serverId, projectSourceId: target.projectSourceId, environmentIds: [target.environmentId] },
  }, environmentResource, snapshot => snapshot);
  if (resource.value === undefined && !resource.error) {
    return <LoadingState layout="line" title={t('vercel.environment.loading', 'Loading Vercel project')} />;
  }
  if (resource.value == null) {
    return <ErrorState layout="line"
      title={t('vercel.environment.unavailable', 'Vercel project details are unavailable')}
      onRetry={refresh} />;
  }
  const { state } = resource.value;
  if (!state || state === 'none' || state === 'detached') {
    return <EmptyState layout="line" title={t('vercel.environment.unlinked', 'No Vercel project linked')} />;
  }
  const status = state === 'configured' ? t('vercel.environment.configured', 'Configured')
    : state === 'provisioned' ? t('vercel.environment.provisioned', 'Ready to finish linking')
      : state === 'deployed' ? t('vercel.environment.deployed', 'Deployed')
        : t('vercel.environment.unknown', 'Unknown');
  return <Metadata entries={[{ label: t('vercel.environment.status', 'Project status'), value: status }]} />;
}
