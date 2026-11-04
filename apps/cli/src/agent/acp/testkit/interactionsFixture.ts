import type {
  HostCurrentSessionInteractionsService,
  HostSessionApprovalRequest,
  HostSessionApprovalResult,
  HostSessionConfirmationRequest,
  HostSessionConfirmationResult,
  HostSessionInteractionOptions,
  HostSessionInteractionRequest,
  HostSessionInteractionResult,
  HostSessionQuestionsRequest,
  HostSessionQuestionsResult,
} from '@/agent/runtime/state/currentSessionUiTypes';

export type TestInteractionRequester = (
  request: HostSessionInteractionRequest,
  options?: HostSessionInteractionOptions,
) => Promise<HostSessionInteractionResult>;

/** The user-interaction boundary keeps the real current-Session overloads. */
export class TestInteractions implements HostCurrentSessionInteractionsService {
  constructor(private readonly requester: TestInteractionRequester) {}

  request(request: HostSessionApprovalRequest, options?: HostSessionInteractionOptions): Promise<HostSessionApprovalResult>;
  request(request: HostSessionQuestionsRequest, options?: HostSessionInteractionOptions): Promise<HostSessionQuestionsResult>;
  request(request: HostSessionConfirmationRequest, options?: HostSessionInteractionOptions): Promise<HostSessionConfirmationResult>;
  async request(request: HostSessionInteractionRequest, options?: HostSessionInteractionOptions): Promise<HostSessionInteractionResult> {
    return await this.requester(request, options);
  }
}
