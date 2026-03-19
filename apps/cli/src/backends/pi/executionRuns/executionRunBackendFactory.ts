import { createPiBackend } from '@/backends/pi/acp/backend';
import { createSimpleExecutionRunBackendFactory } from '@/backends/shared/createSimpleExecutionRunBackendFactory';

export const executionRunBackendFactory = createSimpleExecutionRunBackendFactory(createPiBackend);
