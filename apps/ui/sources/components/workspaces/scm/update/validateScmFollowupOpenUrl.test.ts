import { describe, expect, it } from 'vitest';
import type { ScmFollowupAction } from '@happier-dev/protocol';

import { validateScmFollowupOpenUrl } from './validateScmFollowupOpenUrl';

function openUrlAction(overrides: Partial<Extract<ScmFollowupAction, { kind: 'openUrl' }>> = {}): Extract<ScmFollowupAction, { kind: 'openUrl' }> {
    return {
        kind: 'openUrl',
        purpose: 'pullRequest',
        url: 'https://github.example.com/acme/repo/pull/7',
        allowedBaseUrl: 'https://github.example.com/acme/repo',
        urlSafety: { allowedSchemes: ['https:'] },
        ...overrides,
    };
}

describe('validateScmFollowupOpenUrl', () => {
    it('accepts pull request URLs contained by the backend allowed base URL', () => {
        expect(validateScmFollowupOpenUrl(openUrlAction())).toEqual({
            ok: true,
            url: 'https://github.example.com/acme/repo/pull/7',
        });
    });

    it('rejects URLs outside the backend allowed base path', () => {
        expect(validateScmFollowupOpenUrl(openUrlAction({
            url: 'https://github.example.com/acme/other/pull/7',
        }))).toMatchObject({
            ok: false,
            reason: 'path',
        });
    });

    it('rejects URLs with a scheme the provider did not allow', () => {
        expect(validateScmFollowupOpenUrl(openUrlAction({
            url: 'http://github.example.com/acme/repo/pull/7',
            allowedBaseUrl: 'http://github.example.com/acme/repo',
            urlSafety: { allowedSchemes: ['https:'] },
        }))).toMatchObject({
            ok: false,
            reason: 'scheme',
        });
    });

    it('rejects non pull-request follow-up actions for update-tab opening', () => {
        expect(validateScmFollowupOpenUrl({ kind: 'none' })).toMatchObject({
            ok: false,
            reason: 'kind',
        });
    });
});
