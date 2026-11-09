import type { AuthEntryProjectionV1 } from '@happier-dev/protocol/auth/entry';
import { describe, expect, it } from 'vitest';

import {
    projectAuthEntryMethodCapabilities,
    resolveEmailPasswordProvisionModes,
} from './authMethodCapabilities';

function readyHomeProjection(
    actions: readonly Readonly<{ action: 'login' | 'provision' | 'connect'; mode: 'keyed' | 'keyless' | 'either' }>[],
): Extract<AuthEntryProjectionV1, { state: 'ready' }> {
    return {
        v: 1,
        state: 'ready',
        scope: { kind: 'home' },
        autoRedirect: null,
        actions: actions.map((row) => ({
            kind: 'authenticate' as const,
            methodId: 'email_password' as const,
            action: row.action,
            mode: row.mode,
            origin: 'home' as const,
            presentation: { displayName: 'Email and password' },
        })),
    };
}

describe('email/password auth-entry projection', () => {
    it('projects every published action to its own controller, not only login', () => {
        const capabilities = projectAuthEntryMethodCapabilities(readyHomeProjection([
            { action: 'login', mode: 'either' },
            { action: 'provision', mode: 'keyless' },
            { action: 'connect', mode: 'keyed' },
        ]));

        expect(capabilities.authenticationActions.map((row) => row.execution)).toEqual([
            { kind: 'email_password', action: 'login', mode: 'either' },
            { kind: 'email_password', action: 'provision', mode: 'keyless' },
            { kind: 'email_password', action: 'connect', mode: 'keyed' },
        ]);
    });

    it('never classifies the native locator as an external OAuth provider', () => {
        const capabilities = projectAuthEntryMethodCapabilities(readyHomeProjection([
            { action: 'login', mode: 'either' },
            { action: 'provision', mode: 'either' },
        ]));

        expect(capabilities.authenticationActions.map((row) => row.execution)).toEqual([
            { kind: 'email_password', action: 'login', mode: 'either' },
            { kind: 'email_password', action: 'provision', mode: 'either' },
        ]);
        expect(capabilities.keyedProvisionProviderIds).toEqual([]);
        expect(capabilities.keylessLoginMethodIds).toEqual([]);
        expect(capabilities.configuredKeylessProviderIds).toEqual([]);
    });

    it('reads the exact Account modes a Home admits from the published action mode', () => {
        expect(resolveEmailPasswordProvisionModes('keyed')).toEqual(['e2ee']);
        expect(resolveEmailPasswordProvisionModes('keyless')).toEqual(['plain']);
        expect(resolveEmailPasswordProvisionModes('either')).toEqual(['plain', 'e2ee']);
    });
});
