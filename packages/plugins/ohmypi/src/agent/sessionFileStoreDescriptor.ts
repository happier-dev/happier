import type { SessionFileStoreProductDescriptorV1 } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

export const OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1 = {
  productId: 'ohmypi',
  defaultAgentDirSegments: ['.omp', 'agent'],
  agentDirEnvVar: 'PI_CODING_AGENT_DIR',
  legacySessionDirEnvVars: [],
  readsSettingsSessionDir: false,
  configDirName: '.omp',
  encodeCwdSubdir: null,
} satisfies SessionFileStoreProductDescriptorV1;
