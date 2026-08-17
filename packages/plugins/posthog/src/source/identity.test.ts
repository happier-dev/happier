import { describe, expect, it } from 'vitest';

import { normalizePosthogApiOrigin, type PosthogApiOrigin } from '../connect/origin.js';
import {
    buildPosthogCollisionScope,
    buildPosthogEntryLocator,
    buildPosthogLocalInstanceKey,
    parsePosthogCollisionScope,
} from './identity.js';

function requireOrigin(raw: string): PosthogApiOrigin {
    const resolved = normalizePosthogApiOrigin(raw);
    if (!resolved.ok) throw new Error(`fixture origin must normalize: ${raw}`);
    return resolved.origin;
}

const EU = requireOrigin('https://eu.posthog.com');
const US = requireOrigin('https://us.posthog.com');
const TEAM_UUID = '00000000-0000-4000-8000-0000000000d1';
const ISSUE_UUID = '00000000-0000-4000-8000-000000000001';
const ORG_UUID = '00000000-0000-4000-8000-0000000000b1';

describe('buildPosthogCollisionScope', () => {
    it('scopes an issue by materialized origin plus Team/environment UUID', () => {
        expect(buildPosthogCollisionScope(EU, TEAM_UUID)).toEqual({
            ok: true,
            value: `posthog:https://eu.posthog.com:${TEAM_UUID}`,
        });
    });

    it('keeps two deployments distinct even for the same Team UUID', () => {
        const eu = buildPosthogCollisionScope(EU, TEAM_UUID);
        const us = buildPosthogCollisionScope(US, TEAM_UUID);

        expect(eu.ok && us.ok && eu.value === us.value).toBe(false);
    });

    it('lowercases the Team UUID so one environment has one identity spelling', () => {
        expect(buildPosthogCollisionScope(EU, TEAM_UUID.toUpperCase()))
            .toEqual(buildPosthogCollisionScope(EU, TEAM_UUID));
    });

    it('fails closed rather than minting an origin-plus-integer substitute', () => {
        expect(buildPosthogCollisionScope(EU, '4821'))
            .toEqual({ ok: false, reason: 'invalidTeamUuid' });
        expect(buildPosthogCollisionScope(EU, ''))
            .toEqual({ ok: false, reason: 'invalidTeamUuid' });
        expect(buildPosthogCollisionScope(EU, 'not-a-uuid'))
            .toEqual({ ok: false, reason: 'invalidTeamUuid' });
    });
});

describe('buildPosthogEntryLocator', () => {
    it('emits collision scope plus the lowercased issue UUID and no routing token', () => {
        const locator = buildPosthogEntryLocator(EU, TEAM_UUID, ISSUE_UUID.toUpperCase());

        expect(locator).toEqual({
            ok: true,
            value: {
                collisionScope: `posthog:https://eu.posthog.com:${TEAM_UUID}`,
                entryId: ISSUE_UUID,
            },
        });
        expect(locator.ok && Object.keys(locator.value).sort())
            .toEqual(['collisionScope', 'entryId']);
    });

    it('treats a malformed issue id as a provider-contract failure', () => {
        expect(buildPosthogEntryLocator(EU, TEAM_UUID, '4821'))
            .toEqual({ ok: false, reason: 'invalidIssueUuid' });
    });
});

describe('parsePosthogCollisionScope', () => {
    it('recovers the exact origin and Team UUID a read must target', () => {
        expect(parsePosthogCollisionScope(`posthog:https://eu.posthog.com:${TEAM_UUID}`))
            .toEqual({ origin: 'https://eu.posthog.com', teamUuid: TEAM_UUID });
    });

    it('recovers an origin that carries a non-default port', () => {
        expect(parsePosthogCollisionScope(`posthog:https://analytics.example:8443:${TEAM_UUID}`))
            .toEqual({ origin: 'https://analytics.example:8443', teamUuid: TEAM_UUID });
    });

    it('rejects a scope this source did not mint', () => {
        expect(parsePosthogCollisionScope(`sentry:https://eu.posthog.com:${TEAM_UUID}`)).toBeNull();
        expect(parsePosthogCollisionScope('posthog:https://eu.posthog.com:4821')).toBeNull();
        expect(parsePosthogCollisionScope('posthog:')).toBeNull();
        expect(parsePosthogCollisionScope('')).toBeNull();
    });
});

describe('buildPosthogLocalInstanceKey', () => {
    it('encodes origin and organization only, never the account ref', () => {
        const key = buildPosthogLocalInstanceKey(EU, ORG_UUID);

        expect(key).toEqual({ ok: true, value: `posthog-org:https://eu.posthog.com:${ORG_UUID}` });
        expect(key.ok && key.value).not.toContain('account');
    });

    it('changes when the origin changes, because that is a new identity', () => {
        const eu = buildPosthogLocalInstanceKey(EU, ORG_UUID);
        const us = buildPosthogLocalInstanceKey(US, ORG_UUID);

        expect(eu.ok && us.ok && eu.value === us.value).toBe(false);
    });
});
