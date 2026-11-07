import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import { projectSessionAccessChipSummary } from '@/components/sessions/access/projectSessionAccessChipSummary';
import type { SessionAccessEditorModel, SessionAccessGrantRowModel } from '@/components/sessions/access/sessionAccessEditorTypes';
import { t } from '@/text';

export const DEMO_SESSION_SHARE_RESPONSIBLE_ACCOUNT_ID = 'demo-account-jules';

/** Presentation-only identities: no Account records, credentials or sharing grants are created. */
export function buildDemoSessionShareModel(): SessionAccessEditorModel {
    const reason = { code: 'session_access_read_only', message: t('session.access.readOnly') };
    const grants: SessionAccessGrantRowModel[] = [
        {
            grant: { kind: 'account', accountId: DEMO_SESSION_SHARE_RESPONSIBLE_ACCOUNT_ID },
            principal: presentSharePrincipal({
                ref: { kind: 'account', accountId: DEMO_SESSION_SHARE_RESPONSIBLE_ACCOUNT_ID },
                name: 'Jules Chen',
            }),
            level: { kind: 'locked', value: 'edit', reason },
            permissionDelegation: { kind: 'locked', value: false, reason },
            removal: { kind: 'blocked', reason },
            operation: { kind: 'idle' },
            requiredByTeamPolicy: false,
        },
        {
            grant: { kind: 'account', accountId: 'demo-account-alex' },
            principal: presentSharePrincipal({ ref: { kind: 'account', accountId: 'demo-account-alex' }, name: 'Alex Rivera' }),
            level: { kind: 'locked', value: 'admin', reason },
            permissionDelegation: { kind: 'locked', value: true, reason },
            removal: { kind: 'blocked', reason },
            operation: { kind: 'idle' },
            requiredByTeamPolicy: false,
        },
        {
            grant: { kind: 'team', teamId: 'demo-team-northstar' },
            principal: presentSharePrincipal({ ref: { kind: 'team', teamId: 'demo-team-northstar' }, name: 'Northstar Studio' }),
            level: { kind: 'locked', value: 'view', reason },
            permissionDelegation: { kind: 'hidden' },
            removal: { kind: 'blocked', reason },
            operation: { kind: 'idle' },
            requiredByTeamPolicy: false,
        },
    ];
    return {
        revision: 1,
        accessMode: 'read_only',
        content: { phase: 'ready', hasLastAcknowledgedSnapshot: true },
        owner: { principal: presentSharePrincipal({ ref: { kind: 'account', accountId: 'demo-account-maya' }, name: 'Maya Park' }) },
        grants,
        directory: { sections: [] },
        summary: projectSessionAccessChipSummary({ grants, audienceComplete: true }),
    };
}
