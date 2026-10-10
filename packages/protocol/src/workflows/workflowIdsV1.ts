import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { preservedBoundedNfcString } from '../strings/preservedBoundedNfcString.js';

/** Shared database-identity boundary; semantic schemas import these leaves without pulling progress/runtime graphs. */
export const WorkflowRunIdV1Schema = preservedBoundedNfcString(191, 'Workflow Run ids');
/** New direct admissions use a caller-allocated UUID; stored/read ids also accept incumbent Automation CUIDs. */
export const WorkflowDirectRunAdmissionIdV1Schema = lazyZodSchema(() => z.string().uuid());
export const WorkflowInvocationRecordIdSchema = preservedBoundedNfcString(191, 'Workflow invocation record ids');
export const WorkflowDefinitionIdV1Schema = preservedBoundedNfcString(191, 'Workflow definition ids');
export const WorkflowMachineIdV1Schema = preservedBoundedNfcString(191, 'Workflow Machine ids');
