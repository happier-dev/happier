import { createAuggieBackend } from '@/backends/auggie/acp/backend';
import { createSimpleExecutionRunBackendFactory } from '@/backends/shared/createSimpleExecutionRunBackendFactory';

export const executionRunBackendFactory = createSimpleExecutionRunBackendFactory(createAuggieBackend);
