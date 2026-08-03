import { describe, expect, it } from 'vitest';

import type { SessionSyncCompatibilityPolicy } from './policy';
import { resolveClientAppVersionDecision } from './versionDecision';

function policy(
    minimumVersionsByClientKind?: SessionSyncCompatibilityPolicy['requirements']['minimumVersionsByClientKind'],
    upgradeUrlsByClientKind?: SessionSyncCompatibilityPolicy['requirements']['upgradeUrlsByClientKind'],
): SessionSyncCompatibilityPolicy {
    return {
        valid: true,
        requestedEnforcement: 'required',
        requirements: {
            v: 1,
            enforcement: 'required',
            minimumSessionSyncProtocolVersion: 2,
            currentSessionSyncProtocolVersion: 2,
            declarationTransport: 'headers-v1',
            ...(minimumVersionsByClientKind === undefined ? {} : { minimumVersionsByClientKind }),
            ...(upgradeUrlsByClientKind === undefined ? {} : { upgradeUrlsByClientKind }),
        },
    };
}

describe('resolveClientAppVersionDecision', () => {
    it('uses the session-sync policy as the only app-version floor', () => {
        expect(resolveClientAppVersionDecision({
            clientKind: 'ui-ios',
            appVersion: '0.2.10',
            policy: policy(),
            fallbackUpdateUrl: 'https://apps.example/update',
        })).toEqual({ status: 'current' });

        expect(resolveClientAppVersionDecision({
            clientKind: 'ui-ios',
            appVersion: '0.2.10',
            policy: policy(
                { 'ui-ios': '0.3.0' },
                { 'ui-ios': 'https://happier.dev/upgrade' },
            ),
            fallbackUpdateUrl: 'https://apps.example/update',
        })).toEqual({
            status: 'upgrade-required',
            minimumAppVersion: '0.3.0',
            updateUrl: 'https://happier.dev/upgrade',
        });
    });
});
