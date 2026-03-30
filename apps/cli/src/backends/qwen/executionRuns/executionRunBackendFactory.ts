import { createQwenBackend } from '@/backends/qwen/acp/backend';
import { createSimpleExecutionRunBackendFactory } from '@/backends/shared/createSimpleExecutionRunBackendFactory';

export const executionRunBackendFactory = createSimpleExecutionRunBackendFactory(createQwenBackend);
