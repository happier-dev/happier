import type { PrincipalRefV1} from '@happier-dev/protocol/teams/principal';
import type { SessionAccessLevelV1, SessionGrantIntentV1 } from '@happier-dev/protocol/sessions/access/sessionAccessGrantV1';

/**
 * Composes one grant mutation for a principal of any kind.
 *
 * The mutation is a union keyed by principal kind, so the subject and its value are
 * composed per kind here rather than widened at each caller into a shape no member
 * of that union admits. The live editor and the New Session draft share it because
 * they write the same grant value through different owners.
 */
export function sessionAccessGrantMutation(
    subject: PrincipalRefV1,
    value: Readonly<{ accessLevel: SessionAccessLevelV1; canApprovePermissions: boolean }>,
): SessionGrantIntentV1 {
    switch (subject.kind) {
        case 'account': return { subject, ...value };
        case 'team': return { subject, ...value };
        case 'group': return { subject, ...value };
    }
}
