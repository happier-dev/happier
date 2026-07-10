import { describe, expect, it } from 'vitest';

import type { ResolvedAgentRuntimeContribution } from '@/plugins/projection/registry/types';
import type { LoadedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';

import { mapExternalSessionLaunchHintsToSpawnOptions } from './externalSessionLaunchHints';

function createBackend(id = 'acme.runtime.backend'): ResolvedAgentRuntimeContribution {
    return {
        id,
        agentId: 'acme.runtime.provider',
        provenance: 'external',
        source: { kind: 'path' },
        definition: {
            kindVersion: 1,
            id,
            agentId: 'acme.runtime.provider',
        },
    };
}

function createLinkedSession(
    overrides: Partial<LoadedLinkedExternalSession> = {},
): LoadedLinkedExternalSession {
    return {
        rawSession: {
            id: 'happy-session-1',
            seq: 0,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadata: '',
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
        },
        metadata: {},
        sessionPath: '/repo',
        agentId: 'claude',
        machineId: 'machine-1',
        remoteSessionId: 'remote-session-1',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude', projectId: null },
        codexBackendMode: null,
        ...overrides,
    };
}

describe('mapExternalSessionLaunchHintsToSpawnOptions', () => {
    it('maps provider-declared backend mode hints to neutral spawn options', () => {
        const result = mapExternalSessionLaunchHintsToSpawnOptions({
            backend: createBackend('acme.runtime.backend'),
            hints: {
                backendModeHint: 'vendor-mode',
            },
            linked: createLinkedSession(),
            sessionId: 'session-1',
        });

        expect(result).toMatchObject({
            backendMode: 'vendor-mode',
            backendTarget: {
                kind: 'backend',
                backendId: 'acme.runtime.backend',
                configuredBackendId: 'acme.runtime.backend',
                sourceKind: 'configured',
            },
        });
        expect(result).not.toHaveProperty('codexBackendMode');
    });

    it('does not forward Codex wire metadata without a provider-declared backend mode hint', () => {
        const result = mapExternalSessionLaunchHintsToSpawnOptions({
            backend: createBackend('codex'),
            hints: {},
            linked: createLinkedSession({
                agentId: 'codex',
                source: { kind: 'codexHome', home: 'user' },
                codexBackendMode: 'appServer',
            }),
            sessionId: 'session-1',
        });

        expect(result).not.toHaveProperty('backendMode');
        expect(result).not.toHaveProperty('codexBackendMode');
    });
});
