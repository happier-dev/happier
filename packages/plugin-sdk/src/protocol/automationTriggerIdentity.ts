import { AutomationTriggerRevisionProtocolSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import type { ProtocolComposableSchema } from './protocolFacade.js';

/** Retained trigger references use the Automation owner's revision contract. */
export const ProtocolAutomationTriggerRevisionV1Schema: ProtocolComposableSchema<number> =
    AutomationTriggerRevisionProtocolSchema;
