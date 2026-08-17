import type { SessionFileStoreProductDescriptor as SessionFileStoreProductDescriptorV1 } from '@happier-dev/plugin-sdk/sessions/file-stores';

export const OH_MY_PI_SESSION_FILE_STORE_DESCRIPTOR_V1 = {
  productId: 'ohmypi',
  defaultAgentDirSegments: ['.omp', 'agent'],
  agentDirEnvVar: 'PI_CODING_AGENT_DIR',
  agentDirSettingId: 'ohMyPiAgentDir',
  legacySessionDirEnvVars: [],
  readsSettingsSessionDir: false,
  configDirName: '.omp',
  encodeCwdSubdir: null,
} satisfies SessionFileStoreProductDescriptorV1;
