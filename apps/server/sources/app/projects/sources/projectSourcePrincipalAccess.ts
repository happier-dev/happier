import type { ProjectSourceGrantV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { isTeamPrincipalRoleV1 } from '@happier-dev/protocol/teams';
import type { TeamRole } from '@/storage/enums.generated';

export interface ProjectSourcePrincipalReadContext {
    readonly role: TeamRole;
    readonly manageSettings: boolean;
    readonly groupIds: ReadonlySet<string>;
}

/** A group reference cannot outlive the Source principal scope that admitted it. */

export function projectSourceAdmitsGroup(principals: readonly ProjectSourceGrantV1['principal'][],
    group: Readonly<{ id: string; teamId: string }>,
): boolean {
    return principals.some(principal => principal.kind !== 'account' && principal.teamId === group.teamId
        && (principal.kind === 'team' || principal.groupId === group.id));
}

/** Source reads and selecting referenced principals consume the same visibility rule. */

export function projectSourcePrincipalCanRead(principal: ProjectSourceGrantV1['principal'], accountId: string,
    teamContext: (teamId: string) => ProjectSourcePrincipalReadContext | undefined,
): boolean {
    if (principal.kind === 'account') return principal.accountId === accountId;
    const context = teamContext(principal.teamId);
    if (context?.manageSettings) return true;
    if (!context) return false;
    return principal.kind === 'team' ? isTeamPrincipalRoleV1(context.role) : context.groupIds.has(principal.groupId);
}

/** Validate exact requested identities without enumerating the Source's audience or copying roles. */
