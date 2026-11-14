import type { IdentityConnectionTestDiagnosticsV1 } from '@happier-dev/protocol/identity/testDiagnostics';

import { db } from "@/storage/db";
import type { OAuthFlowProvider } from "@/app/oauth/providers/types";
import { selectMatchingExternalGroupIds } from "@/app/teams/memberships/identityConnectionGroupRefresh";
import { projectTeamGroupNameForRecipient } from "@/app/teams/groups/privateLabels";

import type { OAuthSecurityBinding } from "./oauthExternalSchemas";

/**
 * Turns one provider's normalized test evidence into the sanitized diagnostics an
 * initiating administrator may see.
 *
 * Group values, the subject, the login, and the email never leave this function: the
 * result carries presence, a complete-observation count, the configured rule outcomes,
 * and the native Groups this exact Team connection would contribute to. A missing or
 * incomplete observation maps nothing, so an empty preview is never presented as proof
 * that no mapping matched. This is diagnosis only; nothing here writes.
 */
export async function describeIdentityConnectionTestDiagnostics(input: Readonly<{
    provider: OAuthFlowProvider;
    env: NodeJS.ProcessEnv;
    profile: unknown;
    securityBinding: OAuthSecurityBinding;
    recipientAccountId: string;
}>): Promise<IdentityConnectionTestDiagnosticsV1 | null> {
    const describe = input.provider.describeIdentityTest;
    if (!describe) return null;
    const described = await describe({ env: input.env, profile: input.profile });
    const observedGroups = described.groups.state === "complete" ? described.groups.values : null;

    return {
        subjectPresent: described.subjectPresent,
        loginAvailable: described.loginAvailable,
        emailAvailable: described.emailAvailable,
        emailVerified: described.emailVerified,
        groups: {
            state: described.groups.state,
            count: observedGroups === null ? null : observedGroups.length,
        },
        eligibility: {
            status: described.eligibility.status,
            rules: described.eligibility.rules.map((rule) => ({ kind: rule.kind, matched: rule.matched })),
        },
        mappedGroups: observedGroups === null
            ? []
            : await previewMappedGroups(input.securityBinding, observedGroups, input.recipientAccountId),
    };
}

async function previewMappedGroups(
    securityBinding: OAuthSecurityBinding,
    observedGroups: readonly string[],
    recipientAccountId: string,
): Promise<IdentityConnectionTestDiagnosticsV1["mappedGroups"]> {
    const context = securityBinding.provider.context;
    const connection = securityBinding.connection;
    if (context.kind !== "team" || !connection) return [];

    const bindings = await db.teamExternalGroupBinding.findMany({
        where: { teamId: context.teamId, teamIdentityConnectionId: connection.id },
        orderBy: { id: "asc" },
        select: { externalGroupId: true, group: { select: { id: true, name: true } } },
    });
    const matched = selectMatchingExternalGroupIds(
        bindings.map((binding) => binding.externalGroupId),
        observedGroups,
    );
    const previewed = new Set<string>();
    const mappedGroups: IdentityConnectionTestDiagnosticsV1["mappedGroups"] = [];
    for (const binding of bindings) {
        if (!matched.has(binding.externalGroupId) || previewed.has(binding.group.id)) continue;
        previewed.add(binding.group.id);
        mappedGroups.push({
            id: binding.group.id,
            name: projectTeamGroupNameForRecipient({ serialized: binding.group.name, recipientAccountId }),
        });
    }
    return mappedGroups;
}
