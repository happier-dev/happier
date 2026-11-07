import { describe, expect, it } from 'vitest';

import {
    buildSessionDebugInformation,
    isSessionDebugInformationEnabled,
    resolveProviderSessionIdForDebug,
    resolveProviderSessionArtifactPath,
} from './sessionDebugInformation';

describe('sessionDebugInformation', () => {
    it('enables debug information actions for dev builds or the local developer-mode setting', () => {
        expect(isSessionDebugInformationEnabled(false, false)).toBe(false);
        expect(isSessionDebugInformationEnabled(true, false)).toBe(true);
        expect(isSessionDebugInformationEnabled(false, true)).toBe(true);
    });

    it('builds debug text with only available session values', () => {
        const result = buildSessionDebugInformation({
            session: {
                id: 'happy-session-1',
                metadata: {
                    sessionLogPath: ' /tmp/happier/session.log ',
                },
            },
            providerDisplayName: 'Claude',
            providerSessionId: ' claude-session-1 ',
        });

        expect(result.text).toBe([
            'Session name: unknown',
            'Happier session ID: happy-session-1',
            'Claude session ID: claude-session-1',
            'Happier logs: /tmp/happier/session.log',
        ].join('\n'));
        expect(result.providerSessionArtifactPath).toBeNull();
    });

    it('includes the friendly session name and Codex session log path when available', () => {
        const result = buildSessionDebugInformation({
            session: {
                id: 'happy-session-codex',
                metadata: {
                    name: 'Friendly project name',
                    flavor: 'codex',
                    codexSessionLogPath: '/home/user/.codex/sessions/rollout.jsonl',
                },
            },
            providerDisplayName: 'Codex',
            providerSessionId: 'codex-session-1',
        });

        expect(result.text).toContain('Session name: Friendly project name');
        expect(result.text).toContain('Codex session logs: /home/user/.codex/sessions/rollout.jsonl');
    });

    it('omits unavailable values instead of writing placeholder lines', () => {
        const result = buildSessionDebugInformation({
            session: {
                id: 'happy-session-2',
                metadata: {
                    claudeTranscriptPath: '   ',
                    sessionLogPath: null,
                },
            },
            providerDisplayName: 'Claude',
            providerSessionId: null,
        });

        expect(result.text).toBe(['Session name: unknown', 'Happier session ID: happy-session-2'].join('\n'));
        expect(result.text).not.toContain('Not available');
        expect(result.text).not.toContain('Claude session ID');
        expect(result.text).not.toContain('Happier logs');
        expect(result.text).not.toContain('Claude session logs');
    });

    it('resolves known provider artifact paths from session metadata', () => {
        expect(resolveProviderSessionArtifactPath({
            claudeTranscriptPath: ' /tmp/claude/session.jsonl ',
        })).toBe('/tmp/claude/session.jsonl');

        expect(resolveProviderSessionArtifactPath({
            piSessionFile: ' /tmp/pi/session.jsonl ',
        })).toBe('/tmp/pi/session.jsonl');

        expect(resolveProviderSessionArtifactPath({
            agentRuntimeDescriptorV1: {
                v: 1,
                providerId: 'pi',
                provider: {
                    resumeStrategy: 'sessionFileAbsolutePreferred',
                    sessionFile: ' /tmp/pi/from-runtime.jsonl ',
                },
            },
        })).toBe('/tmp/pi/from-runtime.jsonl');
    });

    it('resolves provider session ids separately from provider artifact paths', () => {
        expect(resolveProviderSessionIdForDebug({
            metadata: {
                agentRuntimeDescriptorV1: {
                    v: 1,
                    providerId: 'pi',
                    provider: {
                        resumeStrategy: 'sessionFileAbsolutePreferred',
                        vendorSessionId: 'pi-session-1',
                        sessionFile: '/tmp/pi/session.jsonl',
                    },
                },
                piSessionId: 'legacy-pi-session',
                piSessionFile: '/tmp/pi/session.jsonl',
            },
            vendorResumeIdField: 'piSessionId',
        })).toBe('pi-session-1');

        expect(resolveProviderSessionIdForDebug({
            metadata: {
                agentRuntimeDescriptorV1: {
                    v: 1,
                    providerId: 'codex',
                    provider: {
                        backendMode: 'appServer',
                        vendorSessionId: 'codex-runtime-session',
                    },
                },
                codexSessionId: 'codex-legacy-session',
            },
            vendorResumeIdField: 'codexSessionId',
        })).toBe('codex-runtime-session');

        expect(resolveProviderSessionIdForDebug({
            metadata: {
                geminiSessionId: ' gemini-session-1 ',
            },
            vendorResumeIdField: 'geminiSessionId',
        })).toBe('gemini-session-1');
    });

    it('adds the provider logs line only when a known artifact path exists', () => {
        const withArtifact = buildSessionDebugInformation({
            session: {
                id: 'happy-session-3',
                metadata: {
                    flavor: 'claude',
                    claudeTranscriptPath: '/tmp/claude/session.jsonl',
                },
            },
            providerDisplayName: 'Claude',
            providerSessionId: 'claude-session-3',
        });

        expect(withArtifact.text).toBe([
            'Session name: unknown',
            'Happier session ID: happy-session-3',
            'Claude session ID: claude-session-3',
            'Claude session logs: /tmp/claude/session.jsonl',
        ].join('\n'));

        const withoutArtifact = buildSessionDebugInformation({
            session: {
                id: 'happy-session-4',
                metadata: {
                    flavor: 'codex',
                },
            },
            providerDisplayName: 'Codex',
            providerSessionId: 'codex-session-4',
        });

        expect(withoutArtifact.text).toBe([
            'Session name: unknown',
            'Happier session ID: happy-session-4',
            'Codex session ID: codex-session-4',
        ].join('\n'));
    });
});
