import { describe, expect, it } from 'vitest';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    INTERNAL_ONLY_RPC_METHODS,
    isInternalOnlyRpcMethod,
    validateInternalOnlyRpcMethodEntries,
} from './_internalAllowlist';

describe('INTERNAL_ONLY_RPC_METHODS', () => {
    it('keeps seed entries queryable with owner packet and rationale metadata', () => {
        const result = validateInternalOnlyRpcMethodEntries();

        expect(result.ok).toBe(true);
        expect(result.errors).toEqual([]);
        expect(INTERNAL_ONLY_RPC_METHODS.length).toBeGreaterThan(0);
        for (const entry of INTERNAL_ONLY_RPC_METHODS) {
            expect(entry.ownerPacket.trim().length).toBeGreaterThan(0);
            expect(entry.rationale.trim().length).toBeGreaterThan(0);
            expect(isInternalOnlyRpcMethod(entry.method)).toBe(true);
        }
    });

    it('rejects duplicate methods and missing rationale metadata', () => {
        const result = validateInternalOnlyRpcMethodEntries([
            { method: 'daemon.lifecycle.stop', rationale: 'daemon lifecycle transport', ownerPacket: 'A.12.0' },
            { method: 'daemon.lifecycle.stop', rationale: 'duplicate transport', ownerPacket: 'A.12.0' },
            { method: 'daemon.lifecycle.restart', rationale: '', ownerPacket: 'A.12.0' },
            { method: 'daemon.lifecycle.pause', rationale: 'missing owner', ownerPacket: '' },
        ]);

        expect(result.ok).toBe(false);
        expect(result.errors.map((error) => error.code)).toEqual([
            'duplicate-method',
            'missing-rationale',
            'missing-owner-packet',
        ]);
    });

    it('leaves session stop for the downstream session-lifecycle migration packet', () => {
        expect(isInternalOnlyRpcMethod(RPC_METHODS.STOP_DAEMON)).toBe(true);
        expect(isInternalOnlyRpcMethod(RPC_METHODS.STOP_SESSION)).toBe(false);
    });

    it('keeps public execution-run transport methods out of the internal-only allowlist', () => {
        const expected = [
            SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
            SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
            SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
            SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ,
            SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL,
        ];

        for (const method of expected) {
            expect(isInternalOnlyRpcMethod(method)).toBe(false);
        }
    });

    it('classifies PMS-5 direct-eligible daemon read methods as internal-only', () => {
        const expected = [
            RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST,
            RPC_METHODS.DAEMON_MEMORY_STATUS,
            RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS,
            RPC_METHODS.DAEMON_EXTENSIONS_RELOAD_STATUS,
            RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES,
            RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS,
            RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES,
            RPC_METHODS.DAEMON_MARKETPLACE_SOURCE_REGISTRY_GET,
            RPC_METHODS.SCM_BACKEND_DESCRIBE,
            RPC_METHODS.CAPABILITIES_DESCRIBE,
        ];

        for (const method of expected) {
            const entry = INTERNAL_ONLY_RPC_METHODS.find((candidate) => candidate.method === method);
            expect(entry).toEqual(expect.objectContaining({
                ownerPacket: 'PMS-5',
            }));
            expect(isInternalOnlyRpcMethod(method)).toBe(true);
        }
    });

    it('classifies A.12 voice cleanup model admin and transfer methods as internal-only', () => {
        const expected = [
            RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_REMOVE,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CHUNK,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_FINALIZE,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_ABORT,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CANCEL,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_ABORT,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE,
            RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_CANCEL,
        ];

        for (const method of expected) {
            const entry = INTERNAL_ONLY_RPC_METHODS.find((candidate) => candidate.method === method);
            expect(entry).toEqual(expect.objectContaining({
                ownerPacket: 'A.12-voice-cleanup',
            }));
            expect(isInternalOnlyRpcMethod(method)).toBe(true);
        }
    });

    it('keeps RAU-6 SSH tunnel lifecycle out of machine RPC internal allowlist', () => {
        expect(INTERNAL_ONLY_RPC_METHODS.filter((entry) => entry.method.startsWith('daemon.sshTunnels.'))).toEqual([]);
    });
});
