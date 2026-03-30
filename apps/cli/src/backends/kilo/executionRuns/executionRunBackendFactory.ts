import { createKiloBackend } from '@/backends/kilo/acp/backend';
import { createSimpleExecutionRunBackendFactory } from '@/backends/shared/createSimpleExecutionRunBackendFactory';

export const executionRunBackendFactory = createSimpleExecutionRunBackendFactory(createKiloBackend);
