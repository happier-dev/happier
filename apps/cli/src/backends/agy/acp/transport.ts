import { DefaultTransport } from '@/agent/transport';

import { isAgyInvokeSubagentInput } from './agySubagentSidechains';

export class AgyTransport extends DefaultTransport {
  constructor() {
    super('agy');
  }

  /** agy reports `invoke_subagent` as a generic `other` call; it is the sub-agent launch its sidechain hangs under. */
  override determineToolName(toolName: string, _toolCallId: string, input: Record<string, unknown>): string {
    return isAgyInvokeSubagentInput(input) ? 'SubAgent' : toolName;
  }
}
