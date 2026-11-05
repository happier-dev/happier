import { ActionApprovalRequestCreatedResultProtocolSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

import type { ActionApprovalRequestCreatedResult } from '../actions/dtos/pluginActionDtoSupport.generated.js';
import type { ProtocolComposableSchema } from './protocolFacade.js';

/** A policy deferral is a pending approval, distinct from every Action's domain result. */
export const ProtocolActionApprovalRequestCreatedResultSchema: ProtocolComposableSchema<ActionApprovalRequestCreatedResult> = ActionApprovalRequestCreatedResultProtocolSchema;
