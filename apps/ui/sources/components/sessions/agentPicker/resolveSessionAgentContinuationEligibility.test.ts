import { describe, expect, it } from 'vitest';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';

import { readRuntimeCapabilitiesForSession } from '@happier-dev/agents';

import { getSessionStorageKind } from '@/sync/domains/session/sessionStorageKind';

import {
    resolveSessionAgentContinuationEligibility,
    resolveSessionAgentContinuationSessionReason,
    type SessionAgentContinuationInspectionState,
    type SessionAgentContinuationSourceState,
} from './resolveSessionAgentContinuationEligibility';

function builtInEntry(
    backendId: string,
    overrides: Partial<ResolvedBackendCatalogEntry> = {},
): ResolvedBackendCatalogEntry {
    return {
        backendTarget: { kind: 'backend', backendId },
        backendTargetKey: `backend:${backendId}`,
        kind: 'builtInAgent',
        backendId,
        agentId: backendId,
        catalogAgentId: backendId as ResolvedBackendCatalogEntry['catalogAgentId'],
        builtInAgentId: backendId as ResolvedBackendCatalogEntry['builtInAgentId'],
        iconAgentId: backendId as ResolvedBackendCatalogEntry['iconAgentId'],
        title: backendId,
        subtitle: null,
        ...overrides,
    };
}

const eligibleSource: SessionAgentContinuationSourceState = {
    currentBackendTargetKey: 'backend:claude',
    storageKind: 'persisted',
    canEditSession: true,
    machinePresence: 'online',
    hasConversationToCarry: true,
};

const SUPPORTED: SessionAgentContinuationInspectionState = {
    status: 'answered',
    inspection: {
        type: 'available',
        protocolVersion: 1,
        sameSessionTransition: true,
    },
};

describe('resolveSessionAgentContinuationEligibility', () => {
    it('keeps the running Agent selectable without treating it as a switch', () => {
        expect(resolveSessionAgentContinuationEligibility({
            entry: builtInEntry('claude'),
            source: eligibleSource,
            inspection: SUPPORTED,
        })).toEqual({ status: 'current' });
    });

    it('offers another built-in Agent when the machine reports continuation support', () => {
        expect(resolveSessionAgentContinuationEligibility({
            entry: builtInEntry('codex'),
            source: eligibleSource,
            inspection: SUPPORTED,
        })).toEqual({ status: 'eligible' });
    });

    it('reports an exact reason for every locally blocked target instead of hiding it', () => {
        const codex = builtInEntry('codex');
        const cases: ReadonlyArray<readonly [Partial<SessionAgentContinuationSourceState>, string]> = [
            [{ canEditSession: false }, 'read_only'],
            [{ storageKind: 'direct' }, 'external_session'],
        ];

        for (const [sourceOverride, reason] of cases) {
            expect(resolveSessionAgentContinuationEligibility({
                entry: codex,
                source: { ...eligibleSource, ...sourceOverride },
                inspection: SUPPORTED,
            })).toEqual({ status: 'unavailable', kind: 'local', reason });
        }
    });

    it('asks where this Session keeps its transcript, not whether its Agent could keep one', () => {
        // The regression this pins: the row used to read the AGENT-level
        // `sessionStorage.direct` capability, which Claude Code and Codex both
        // declare — they are *able* to own a native store — so every ordinary
        // hosted Session resolved as unswitchable and the whole picker was dead.
        // Only the canonical Session-scoped owner answers the question asked here.
        const hostedSession = { metadata: { path: '/repo', host: 'machine-1' } };
        for (const agentId of ['claude', 'codex'] as const) {
            expect(readRuntimeCapabilitiesForSession({
                agentId,
                metadata: hostedSession.metadata,
            })?.sessionStorage?.direct).toBe(true);
        }
        expect(getSessionStorageKind(hostedSession)).toBe('persisted');
        expect(resolveSessionAgentContinuationEligibility({
            entry: builtInEntry('codex'),
            source: { ...eligibleSource, storageKind: getSessionStorageKind(hostedSession) },
            inspection: SUPPORTED,
        })).toEqual({ status: 'eligible' });

        // A Session whose transcript really does live in its Agent's own store is
        // still excluded — the fix narrows the predicate, it does not remove it.
        const externalSession = {
            metadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'claude',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-1',
                    source: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: null },
                },
            },
        };
        expect(getSessionStorageKind(externalSession)).toBe('direct');
        expect(resolveSessionAgentContinuationEligibility({
            entry: builtInEntry('codex'),
            source: { ...eligibleSource, storageKind: getSessionStorageKind(externalSession) },
            inspection: SUPPORTED,
        })).toEqual({ status: 'unavailable', kind: 'local', reason: 'external_session' });
    });

    it('decides the Session-scoped question once, without naming a target', () => {
        expect(resolveSessionAgentContinuationSessionReason(eligibleSource)).toBeNull();
        expect(resolveSessionAgentContinuationSessionReason({
            ...eligibleSource,
            canEditSession: false,
        })).toBe('read_only');
        expect(resolveSessionAgentContinuationSessionReason({
            ...eligibleSource,
            storageKind: 'direct',
        })).toBe('external_session');
    });

    it('says it is still asking the machine rather than inventing a verdict', () => {
        expect(resolveSessionAgentContinuationEligibility({
            entry: builtInEntry('codex'),
            source: eligibleSource,
            inspection: { status: 'checking' },
        })).toEqual({ status: 'checking' });
    });

    it('delegates machine and daemon availability to the shared continuation presentation owner', () => {
        const codex = builtInEntry('codex');
        const unavailable = (
            reason: 'operation_unavailable' | 'unsupported_session' | 'target_unavailable',
        ): SessionAgentContinuationInspectionState => (
            { status: 'answered', inspection: { type: 'unavailable', reason } }
        );
        const cases: ReadonlyArray<readonly [
            SessionAgentContinuationInspectionState,
            Partial<SessionAgentContinuationSourceState>,
            string,
        ]> = [
            // METHOD_NOT_AVAILABLE collapses "old daemon" and "unreachable machine",
            // so presence is what narrows it.
            [unavailable('operation_unavailable'), { machinePresence: 'online' }, 'update_cli'],
            [unavailable('operation_unavailable'), { machinePresence: 'offline' }, 'machine_offline'],
            [unavailable('operation_unavailable'), { machinePresence: 'unknown' }, 'update_or_reconnect'],
            [unavailable('unsupported_session'), {}, 'unsupported_session'],
            [unavailable('target_unavailable'), {}, 'target_unavailable'],
            [{
                status: 'answered',
                inspection: {
                    type: 'available',
                    protocolVersion: 1,
                    sameSessionTransition: false,
                },
            }, {}, 'unsupported_session'],
        ];

        for (const [inspection, sourceOverride, presentation] of cases) {
            expect(resolveSessionAgentContinuationEligibility({
                entry: codex,
                source: { ...eligibleSource, ...sourceOverride },
                inspection,
            })).toEqual({ status: 'unavailable', kind: 'continuation', presentation });
        }
    });

    it('never blames the CLI for a call that failed without proving anything', () => {
        // A timeout, a dropped socket or an unreadable answer is not evidence that
        // the daemon predates the operation, so an online machine must not be told
        // to update. Only the genuinely ambiguous copy is truthful here.
        for (const machinePresence of ['online', 'offline', 'unknown'] as const) {
            expect(resolveSessionAgentContinuationEligibility({
                entry: builtInEntry('codex'),
                source: { ...eligibleSource, machinePresence },
                inspection: { status: 'indeterminate' },
            })).toEqual({
                status: 'unavailable',
                kind: 'continuation',
                presentation: 'update_or_reconnect',
            });
        }
    });

    it('blocks a target that cannot host a Happier Session', () => {
        expect(resolveSessionAgentContinuationEligibility({
            entry: builtInEntry('codex', { capabilities: { session: { supported: false } } as ResolvedBackendCatalogEntry['capabilities'] }),
            source: eligibleSource,
            inspection: SUPPORTED,
        })).toEqual({ status: 'unavailable', kind: 'local', reason: 'target_no_sessions' });
    });

    it('blocks configured and plugin-provided targets whose contract is not proven', () => {
        for (const kind of ['configuredBackend', 'pluginBackend'] as const) {
            expect(resolveSessionAgentContinuationEligibility({
                entry: builtInEntry('ultracode', { kind }),
                source: eligibleSource,
                inspection: SUPPORTED,
            })).toEqual({ status: 'unavailable', kind: 'local', reason: 'target_not_proven' });
        }
    });

    it('answers about this Session before answering about the target', () => {
        // A reader is told once that they cannot send, rather than once per Agent for
        // whichever target-specific reason happens to apply too. The same order keeps
        // a locally blocked row from flickering through a pointless "checking" state.
        expect(resolveSessionAgentContinuationEligibility({
            entry: builtInEntry('ultracode', { kind: 'configuredBackend' }),
            source: { ...eligibleSource, canEditSession: false },
            inspection: { status: 'checking' },
        })).toEqual({ status: 'unavailable', kind: 'local', reason: 'read_only' });
    });

    it('never treats an unreported inspection result as available', () => {
        for (const inspection of [
            { status: 'checking' },
            { status: 'indeterminate' },
        ] as const satisfies ReadonlyArray<SessionAgentContinuationInspectionState>) {
            expect(resolveSessionAgentContinuationEligibility({
                entry: builtInEntry('codex'),
                source: eligibleSource,
                inspection,
            })).not.toEqual({ status: 'eligible' });
        }
    });
});
