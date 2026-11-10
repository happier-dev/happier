import { MAX_TRIAGE_TEXT_UTF8_BYTES_V1 } from './bounds.js';
import { createTriageListSourceSchemasV1 } from './listSourceSchemas.js';

export const triageListSourceSchemasV1 = createTriageListSourceSchemasV1(MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
