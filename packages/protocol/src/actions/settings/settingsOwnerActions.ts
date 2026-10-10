import type { z } from 'zod';
import type { SettingsDeclarationValueV1Schema } from '../settingsDeclarationActionFamily.js';
import type { ActionExecutorContext } from '../executor/types.js';
import type { ActionExecuteResult } from '../actionExecutionResult.js';
import type { TeamAdmissionModeV1 } from '../../teams/index.js';

export type SettingDomainValueV1 = z.infer<typeof SettingsDeclarationValueV1Schema>;
export type SettingsOwnerActionExecuteV1 = (request: Readonly<{
    actionId: 'home.settings.get' | 'home.settings.set' | 'session.follow.preferences.get' | 'session.follow.preferences.set'
        | 'teams.get' | 'teams.policy.set' | 'teams.identity.connections.list' | 'teams.identity.connections.settings.update';
    input: unknown;
    context: ActionExecutorContext;
}>) => Promise<ActionExecuteResult>;

export type TeamSettingBindingV1 = Readonly<{ scope: 'team'; access: 'read_write' | 'read_only' | 'sensitive' }> & (
    | Readonly<{ kind: 'teamAdmissionMode'; mode: TeamAdmissionModeV1 }>
    | Readonly<{ kind: 'teamAuthentication'; field: 'inherit' | 'restricted' | 'accepted' }>
    | Readonly<{ kind: 'teamIdentityConnection'; field: 'allowedUsers' | 'allowedEmailDomains' | 'groupsAny' | 'groupsAll' | 'organizationLogin' }>
);
