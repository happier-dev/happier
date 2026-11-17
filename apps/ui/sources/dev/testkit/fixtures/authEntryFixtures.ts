import { AuthEntryProjectionV1Schema, type AuthEntryProjectionV1 } from '@happier-dev/protocol/auth/entry';

/** The Home's email/password sign-in entry shared by password form journeys. */
export function emailPasswordHomeLoginEntryFixture(): AuthEntryProjectionV1 {
    return AuthEntryProjectionV1Schema.parse({
        v: 1,
        state: 'ready',
        scope: { kind: 'home' },
        autoRedirect: null,
        actions: [{ kind: 'authenticate', methodId: 'email_password', action: 'login', mode: 'either',
            origin: 'home', presentation: { displayName: 'Email and password' } }],
    });
}
