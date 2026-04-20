import {
  ExecutionRunHostBridge,
  type ExecutionRunHostBridgeOptions,
} from '../../runtime/bridges/executionRun/ExecutionRunHostBridge';

export type ExecutionRunManagerOptions = ExecutionRunHostBridgeOptions;

/**
 * Compatibility shell: execution-run lifecycle ownership now lives in the host bridge.
 * Keep this class name/path stable while V2 bridge migration consumers converge.
 */
export class ExecutionRunManager extends ExecutionRunHostBridge {
  constructor(opts: ExecutionRunManagerOptions) {
    super(opts);
  }
}
