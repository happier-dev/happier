import { createKimiBackend } from '@/backends/kimi/acp/backend';
import { createSimpleExecutionRunBackendFactory } from '@/backends/shared/createSimpleExecutionRunBackendFactory';

export const executionRunBackendFactory = createSimpleExecutionRunBackendFactory(createKimiBackend);
