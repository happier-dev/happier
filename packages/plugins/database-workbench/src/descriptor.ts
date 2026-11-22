import { readAutomationDatabaseSubjectV1 } from '@happier-dev/plugin-sdk/automations';
import type { DatabaseDescriptorV1 } from '@happier-dev/plugin-sdk/database';

export function projectDatabaseDescriptor(descriptor: DatabaseDescriptorV1): DatabaseDescriptorV1 {
    return {
        ...descriptor,
        automationSubject: descriptor.automationSubject
            ?? readAutomationDatabaseSubjectV1(descriptor.placement.serverId, descriptor.target),
    };
}
