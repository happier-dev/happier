import { createScmBackendCatalog } from './backends/catalog';
import { createScmBackendRegistry, type ScmBackendRegistry } from './registry';

export const defaultScmBackendRegistry: ScmBackendRegistry = createScmBackendRegistry(createScmBackendCatalog());
