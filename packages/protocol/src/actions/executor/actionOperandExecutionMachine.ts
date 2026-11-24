import {
  findActionSpec,
  resolveActionExecutionPlacementForInput,
} from '../actionSpecs.js';
import { readLocalServiceControlActionRequest } from '../specs/localServices.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { normalizeId } from './inputReading.js';

/**
 * The Machine this invocation executes on, as its Action spec's own placement
 * declares it for the admitted operand. Not an admission or routing authority:
 * the effect owner still admits its target, and Home admits any Run placed here.
 */
export function readActionOperandExecutionMachineV1(
  args: Readonly<{
    actionId: string;
    /** Operand carrying the Machine id. */
    input: unknown;
    /** Schema-admitted payload for placement, when it differs from the durable operand. */
    placementInput?: unknown;
    caller: Parameters<typeof resolveActionExecutionPlacementForInput>[2];
    surface: Parameters<typeof resolveActionExecutionPlacementForInput>[3];
  }>,
): string | undefined {
  const spec = findActionSpec(args.actionId);
  const placement = spec
    ? resolveActionExecutionPlacementForInput(
        spec,
        args.placementInput ?? args.input,
        args.caller,
        args.surface,
      )
    : undefined;
  return (
    (placement === 'machine'
      ? normalizeId(readRecord(args.input).machineId)
      : '') ||
    readLocalServiceControlActionRequest(args.actionId, args.input)?.target
      .machineId ||
    undefined
  );
}
