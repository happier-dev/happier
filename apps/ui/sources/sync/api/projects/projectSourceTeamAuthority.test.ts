import { describe, expect, it } from 'vitest';
import { AccountApiTokenSummaryV1Schema, ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountApiTokens';
import { API_TOKEN_FULL_GRANT_V1, type ApiTokenGrantV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { readProjectSourceTeamApiTokens, type ProjectSourceTeamTokenAccount } from './projectSourceTeamAuthority';

const scope = { serverId: 'home-a', accountId: 'account-a' };
function token(index: number, grant: ApiTokenGrantV1) {
    return AccountApiTokenSummaryV1Schema.parse({
        tokenId: `00000000-0000-4000-8000-00000000000${index}`, label: `Deploy ${index}`,
        displayPrefix: 'hap_v1_00000000', createdAt: '2026-10-28T00:00:00.000Z', lastUsedAt: null,
        expiresAt: null, hasEncryptionAccess: false, hasUnattendedTeamAccess: false,
        grant, parentTokenId: null, activeChildCount: 2, embedConfig: null,
    });
}
function port(request: ProjectSourceTeamTokenAccount['request'], assertCurrent = () => {}): ProjectSourceTeamTokenAccount {
    return { request, assertCurrent, accountLifetime: { scope } };
}
const deployGrant = (environments: string[]): ApiTokenGrantV1 => ({ ...API_TOKEN_FULL_GRANT_V1,
    actions: { families: [], ids: ['deployments.deploy', 'action.operations.get'] },
    targets: { environments, sessions: [], machines: [] },
});

describe('Move to Team API-token inventory', () => {
    it('lists exact Environment and unrestricted deploy grants from the current Account without reading token secrets', async () => {
        const own = token(1, deployGrant(['environment-a']));
        const broad = token(2, API_TOKEN_FULL_GRANT_V1);
        const foreign = token(3, deployGrant(['environment-b']));
        const machinesOnly = token(4, { ...deployGrant([]), targets: { sessions: [], machines: ['controller'] } });
        let requests = 0;
        const account = port(async (path, init) => {
            requests++;
            expect(path).toBe(ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1);
            expect(JSON.parse(String(init?.body))).toEqual({ includeChildren: true });
            return Response.json({ tokens: [own, broad, foreign, machinesOnly] });
        });
        expect(await readProjectSourceTeamApiTokens({ account, environmentIds: ['environment-a'], context: {} }))
            .toEqual({ kind: 'ready', tokens: [own, broad] });
        expect(requests).toBe(1);
    });

    it('includes delegated deploy credentials alongside their root in the complete Move inventory', async () => {
        const root = token(1, deployGrant(['environment-a', 'environment-b']));
        const child = { ...token(2, deployGrant(['environment-a'])), parentTokenId: root.tokenId,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(), activeChildCount: 0 };
        const account = port(async (path, init) => {
            expect(path).toBe(ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1);
            const input: unknown = JSON.parse(String(init?.body));
            // The token-management HTTP owner exposes delegated summaries only
            // for an explicitly complete inventory; roots remain its default.
            const includeChildren = Boolean(input && typeof input === 'object'
                && 'includeChildren' in input && input.includeChildren === true);
            return Response.json({ tokens: includeChildren ? [root, child] : [root] });
        });
        expect(await readProjectSourceTeamApiTokens({ account, environmentIds: ['environment-a'], context: {} }))
            .toEqual({ kind: 'ready', tokens: [root, child] });
    });

    it('does not turn an unsupported or malformed inventory into an empty ready list', async () => {
        for (const response of [Response.json({}, { status: 404 }), Response.json({ tokens: [{}] })]) {
            const result = await readProjectSourceTeamApiTokens({ account: port(async () => response),
                environmentIds: ['environment-a'], context: {} });
            expect(result).toMatchObject({ ok: false });
            expect(result).not.toHaveProperty('tokens');
        }
        expect(await readProjectSourceTeamApiTokens({
            account: port(async () => Response.json({ error: 'present_user_required' }, { status: 403 })),
            environmentIds: ['environment-a'], context: {},
        })).toEqual({ ok: false, errorCode: 'present_user_required', error: 'present_user_required' });
    });

    it('keeps an inventory read cancellable through body completion and refuses retired Account content', async () => {
        const controller = new AbortController();
        let current = true;
        const assertCurrent = () => {
            if (!current) throw Object.assign(new Error('retired'), { code: 'action_account_scope_changed' });
        };
        const account = port(async (_path, init) => {
            expect(init?.signal).toBe(controller.signal);
            current = false;
            return Response.json({ tokens: [token(1, API_TOKEN_FULL_GRANT_V1)] });
        }, assertCurrent);
        expect(await readProjectSourceTeamApiTokens({ account, environmentIds: ['environment-a'],
            context: { signal: controller.signal } })).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        controller.abort();
        expect(await readProjectSourceTeamApiTokens({ account: port(async () => { throw new Error('must not issue'); }),
            environmentIds: ['environment-a'], context: { signal: controller.signal } }))
            .toMatchObject({ ok: false, errorCode: 'cancelled' });
        const bodyLifetime = new AbortController();
        const duringBody = port(async () => {
            const response = Response.json({ tokens: [token(1, API_TOKEN_FULL_GRANT_V1)] });
            const text = response.text.bind(response);
            // The HTTP body's completion is the external boundary being cancelled.
            response.text = async () => { bodyLifetime.abort(); return text(); };
            return response;
        });
        expect(await readProjectSourceTeamApiTokens({ account: duringBody, environmentIds: ['environment-a'],
            context: { signal: bodyLifetime.signal } })).toMatchObject({ ok: false, errorCode: 'cancelled' });
    });
});
