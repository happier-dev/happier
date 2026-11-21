export const railwayAccount = { service: { pluginId: 'happier.machine.railway', localId: 'railway-account' }, accountId: 'qa-account' };
export const repository = { kind: 'github', deployment: 'https://github.com', repository: 'example/backend' } as const;
export const providerIdentity = { providerAccountId: 'railway-project', providerResourceId: 'railway-service', providerEnvironment: 'railway-env' };
export const providerEnvironment = { kind: 'native', selection: {
  projectId: providerIdentity.providerAccountId, environmentId: providerIdentity.providerEnvironment,
  serviceId: providerIdentity.providerResourceId,
} } as const;
export const railwayServiceInstance = {
  environmentId: providerIdentity.providerEnvironment, serviceId: providerIdentity.providerResourceId,
  service: { id: providerIdentity.providerResourceId, projectId: providerIdentity.providerAccountId },
  serviceName: 'Backend', source: { repo: 'Example/Backend', image: null },
};
export const reviewedSha = 'a'.repeat(40);
export const nativeDeploymentId = 'deployment-railway';
export const providerObservation = {
  id: nativeDeploymentId, status: 'SUCCESS', projectId: providerIdentity.providerAccountId,
  serviceId: providerIdentity.providerResourceId, environmentId: providerIdentity.providerEnvironment,
  meta: { commitHash: reviewedSha },
};
