import type { z } from 'zod/mini';
import type { ACTION_ID_FAMILIES_V1 } from '../actionIds.js';
import type { PluginActionInputById, PublicActionInputById } from '../actionSpecs.js';
import type {
  EXECUTION_RUN_ACTION_SPECS,
  ExecutionRunStartInputSchema,
  ExecutionRunStartPluginInputSchema,
  ExecutionRunWaitInputSchema,
  ExecutionRunWaitPublicInputSchema,
} from './executionRuns.js';
import type { ExecutionRunStartResponseSchema, ExecutionRunWaitResultSchema } from '../../execution/runs/responseSchemas.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

// Declaration-size annotations must retain the schemas selected by each Action id.
type Rows = (typeof EXECUTION_RUN_ACTION_SPECS)[number];
type Ids = Assert<Equal<Rows['id'], (typeof ACTION_ID_FAMILIES_V1)['execution_run_control'][number]>>;
type StartRow = Extract<Rows, { id: 'execution.run.start' }>;
type StartInput = Assert<Equal<StartRow['inputSchema'], typeof ExecutionRunStartInputSchema>>;
type StartOutput = Assert<Equal<StartRow['outputSchema'], typeof ExecutionRunStartResponseSchema>>;
type StartPluginInput = Assert<Equal<PluginActionInputById['execution.run.start'], z.input<typeof ExecutionRunStartPluginInputSchema>>>;
type WaitRow = Extract<Rows, { id: 'execution.run.wait' }>;
type WaitInput = Assert<Equal<WaitRow['inputSchema'], typeof ExecutionRunWaitInputSchema>>;
type WaitOutput = Assert<Equal<WaitRow['outputSchema'], typeof ExecutionRunWaitResultSchema>>;
type WaitPublicInput = Assert<Equal<PublicActionInputById['execution.run.wait'], z.input<typeof ExecutionRunWaitPublicInputSchema>>>;
