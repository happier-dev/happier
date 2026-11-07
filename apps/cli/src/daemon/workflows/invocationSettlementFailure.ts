/** An accepted leaf result is unchanged when its required settlement fails. */
export class WorkflowInvocationSettlementFailure extends Error {
  readonly state: 'failed' | 'interrupted';

  constructor(message: string, readonly code: string, readonly terminal: boolean) {
    super(message);
    this.state = terminal ? 'failed' : 'interrupted';
  }
}
