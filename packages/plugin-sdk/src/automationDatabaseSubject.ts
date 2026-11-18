import { AutomationDatabaseSubjectReadV1Schema } from '@happier-dev/protocol/automations/automationSubjectV1';
import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';

import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';

export { readAutomationDatabaseSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
export type { AutomationDatabaseSubjectReadV1 } from '@happier-dev/protocol/automations/automationSubjectV1';

export const ProtocolAutomationDatabaseSubjectReadV1Schema: ProtocolComposableSchema<
    unknown,
    ReturnType<typeof AutomationDatabaseSubjectReadV1Schema.parse>
> = projectZodProtocolSchema(AutomationDatabaseSubjectReadV1Schema);
