import { AutomationDatabaseFindingSubjectV1Schema, AutomationDatabaseSubjectV1Schema,
    automationSubjectKeyV1 as canonicalAutomationSubjectKeyV1,
    projectAutomationDatabaseSubjectV1 as canonicalProjectAutomationDatabaseSubjectV1,
    type AutomationDatabaseFindingSubjectV1, type AutomationDatabaseSubjectV1, type AutomationSubjectV1,
} from '@happier-dev/protocol/automations/automationSubjectV1';
import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import type { ProtocolComposableSchema } from '../protocol/protocolFacade.js';

export { projectAutomationDatabaseFindingSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
export type { AutomationDatabaseFindingSubjectV1, AutomationDatabaseSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';

/** Event sources consume AE's parser and identity without a second subject union. */
export const AutomationDatabaseSubjectV1ProtocolSchema: ProtocolComposableSchema<AutomationDatabaseSubjectV1> =
    projectZodProtocolSchema(AutomationDatabaseSubjectV1Schema);
export const AutomationDatabaseFindingSubjectV1ProtocolSchema: ProtocolComposableSchema<AutomationDatabaseFindingSubjectV1> =
    projectZodProtocolSchema(AutomationDatabaseFindingSubjectV1Schema);
export const projectAutomationDatabaseSubjectV1: (subject: AutomationDatabaseSubjectV1) => AutomationDatabaseSubjectV1 =
    canonicalProjectAutomationDatabaseSubjectV1;
export const automationSubjectKeyV1: (subject: AutomationSubjectV1, workflowId?: string) => string = canonicalAutomationSubjectKeyV1;
