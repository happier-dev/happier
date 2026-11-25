/** @vitest-environment jsdom */
import { it } from 'vitest';

import { expectColdHomeLaunch } from './coldHomeLaunchTestHarness';

it.each([
    { title: 'unauthorized', respond: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
        code: 'unauthorized', action: 'restore', signsOut: true },
    { title: 'forbidden', respond: () => Response.json({ error: 'forbidden' }, { status: 403 }),
        code: 'forbidden', action: 'restore' },
    { title: 'account-readiness', respond: () => Response.json({ error: 'migration-required',
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' } }, { status: 400 }),
        code: 'encryption_setup_required', action: 'none' },
    { title: 'redirect-refused', respond: () => Object.defineProperty(
        Response.redirect('https://other-home.example.test/', 302), 'type', { value: 'opaqueredirect' }),
        code: 'credential_request_redirect_refused', action: 'none' },
    { title: 'client-upgrade-required', respond: () => Response.json({ error: 'client-upgrade-required',
        requirement: { v: 1, kind: 'account-stored-content', minimumProtocolVersion: 1 } }, { status: 426 }),
        code: 'client-upgrade-required', action: 'update' },
    { title: 'operation-update-required', respond: () => Response.json({ kind: 'update_required',
        operation: 'account-encryption-currentness', component: 'server', reason: 'unsupported-version' }, { status: 409 }),
        code: 'update_required', action: 'update',
        guidanceUrl: 'https://docs.happier.dev/releases/updates#server--self-host-updates' },
    { title: 'credential-retired', respond: () => Response.json({ error: 'credential_scope_retired' }, { status: 401 }),
        code: 'credential_scope_retired', action: 'restore', signsOut: true },
    { title: 'cleared-credential', retire: 'clear', code: 'credential_scope_retired', action: 'restore', signsOut: true },
    { title: 'replaced-credential', retire: 'replace', code: 'credential_scope_retired', action: 'restore' },
    { title: 'known-outage', retryPending: true, code: 'server_unreachable', action: 'retry' },
    { title: 'rate-limited-currentness', respond: () => Response.json({ error: 'retry_later' }, { status: 429, headers: { 'Retry-After': '30' } }),
        code: 'account-encryption-currentness-unavailable', status: 429, action: 'retry' },
] as const)('shows the owner’s $title verdict and permitted action', async fixture => {
    await expectColdHomeLaunch('home', fixture);
});

it('applies sign-out during a failed cold restore and stops requests with the previous bearer', async () => {
    await expectColdHomeLaunch('home', {
        title: 'sign-out-after-rate-limit', respond: () => Response.json({ error: 'retry_later' },
            { status: 429, headers: { 'Retry-After': '30' } }),
        code: 'account-encryption-currentness-unavailable', status: 429, action: 'retry', signOutDuringRecovery: true,
    });
});
