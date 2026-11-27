import { describe, expect, it } from 'vitest';

import { redactSentryTelemetry } from './sentryTelemetryRedaction';

describe('sentry telemetry redaction', () => {
    it('templates public bearer capabilities across event, transaction, log, and breadcrumb fields', () => {
        const capability = 'SENTINEL_PUBLIC_SHARE_CAPABILITY';
        const redacted = redactSentryTelemetry({
            transaction: `GET /share/${capability}`,
            request: {
                url: `https://app.example.test/share/${capability}`,
            },
            message: new String(`failed /share/${capability}`),
            breadcrumbs: [{
                data: {
                    url: `/share/${capability}`,
                },
            }],
        });

        expect(JSON.stringify(redacted)).not.toContain(capability);
    });

    it('removes self-hosted server hosts and paths but keeps Happier hosts without query or fragment', () => {
        const redacted = redactSentryTelemetry({
            request: {
                url: 'https://happier.selfhosted.example.org/terminal/connect?server=https%3A%2F%2Fprivate.example#key=PAIRING_SECRET',
                headers: { Referer: 'http://192.168.1.20:3005/session/abc' },
            },
            breadcrumbs: [
                {
                    category: 'fetch',
                    data: { url: 'https://happier.selfhosted.example.org/v1/sessions/private-project?limit=50', method: 'GET' },
                },
                {
                    category: 'fetch',
                    data: { url: 'https://api.happier.dev/v1/sessions?cursor=PRIVATE_CURSOR#frag', method: 'GET' },
                },
                {
                    category: 'console',
                    message: 'connect failed for ws://localhost:3005/v1/updates and happier://terminal?server=https://private.example',
                },
            ],
        });

        const serialized = JSON.stringify(redacted);
        for (const leaked of ['selfhosted.example.org', 'private-project', '192.168.1.20', 'localhost', 'private.example', 'PAIRING_SECRET', 'PRIVATE_CURSOR', 'frag']) {
            expect(serialized).not.toContain(leaked);
        }
        expect(redacted.breadcrumbs[1]?.data?.url).toBe('https://api.happier.dev/v1/sessions');
        expect(redacted.breadcrumbs[0]?.data?.method).toBe('GET');
    });

    it('removes absolute filesystem paths in POSIX, Windows and home-relative forms', () => {
        const redacted = redactSentryTelemetry({
            message: "ENOENT: no such file or directory, open '/Users/alice smith/work/secret-repo/.env'",
            exception: {
                values: [{
                    type: 'Error',
                    value: 'spawn failed in /home/alice/secret-repo (cwd C:\\Users\\Alice\\secret-repo, also ~/secret-repo/src and \\\\fileserver\\share\\secret-repo)',
                }],
            },
            extra: {
                note: 'worktree at /tmp/secret-repo-worktree was removed',
            },
        });

        const serialized = JSON.stringify(redacted);
        for (const leaked of ['alice', 'Alice', 'secret-repo', 'fileserver']) {
            expect(serialized).not.toContain(leaked);
        }
        expect(redacted.exception.values[0]?.type).toBe('Error');
        expect(redacted.exception.values[0]?.value).toContain('spawn failed in');
    });

    it('redacts machine, session, account and path fields while keeping diagnostic fields', () => {
        const redacted = redactSentryTelemetry({
            extra: {
                phase: 'create_session',
                machineId: 'machine-7f3a',
                sessionId: 'session-91c2',
                accountId: 'account-11',
                server_id: 'server-xyz',
                selectedPath: 'projects/secret-repo',
                cwd: 'secret-repo',
                hadRollbackPath: true,
                durationMs: 120,
            },
            event_id: 'a1b2c3d4e5f6',
            contexts: { trace: { trace_id: 'trace-1', span_id: 'span-1' } },
        });

        expect(redacted.extra).toEqual({
            phase: 'create_session',
            machineId: '[redacted]',
            sessionId: '[redacted]',
            accountId: '[redacted]',
            server_id: '[redacted]',
            selectedPath: '[redacted]',
            cwd: '[redacted]',
            hadRollbackPath: true,
            durationMs: 120,
        });
        expect(redacted.event_id).toBe('a1b2c3d4e5f6');
        expect(redacted.contexts.trace).toEqual({ trace_id: 'trace-1', span_id: 'span-1' });
    });

    it('keeps stack traces and error types intact', () => {
        const stacktrace = {
            frames: [
                { filename: 'app:///index.android.bundle', function: 'createSession', lineno: 10, colno: 4, in_app: true },
                { filename: '/Users/builder/happier/apps/ui/sources/sync/sync.ts', abs_path: 'https://app.happier.dev/_expo/static/js/web/entry.js', function: 'Sync.init', lineno: 2 },
            ],
        };
        const redacted = redactSentryTelemetry({
            exception: {
                values: [{ type: 'TypeError', value: "Cannot read properties of undefined (reading 'id')", stacktrace }],
            },
        });

        expect(redacted.exception.values[0]).toEqual({
            type: 'TypeError',
            value: "Cannot read properties of undefined (reading 'id')",
            stacktrace,
        });
    });
});
